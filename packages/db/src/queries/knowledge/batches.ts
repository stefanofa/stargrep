import { RepoId } from "@stargrep/github/schemas";
import { BatchId, InputHash } from "@stargrep/knowledge/ids";
import { sql } from "drizzle-orm";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../../errors.ts";
import { lockedRepoIds } from "../../lock-order.ts";
import * as Postgres from "../../postgres.ts";
import { rowsDecoder, statements, timeParam } from "../../rows.ts";
import { batchState } from "../../schema.ts";

export const BatchAdapter = Schema.Literals(["gateway-batch", "claude-code"]);
export type BatchAdapter = typeof BatchAdapter.Type;

export const BatchState = Schema.Literals(batchState.enumValues);
export type BatchState = typeof BatchState.Type;

// One prefill request as its manifest row records it. Item i is repoIds[i], asked about the inputs inputHashes[i] names.
// The repos it still owes an answer hold its lease: enrich_retry_at equals leaseUntil until capture saves, keeps, or
// settles their item, so the lease is each item's state and nothing else is.
export const Manifest = Schema.Struct({
  id: BatchId,
  adapter: BatchAdapter,
  model: Schema.String,
  recipe: Schema.Int,
  requestKey: Schema.String,
  requestObject: Schema.String,
  providerBatchId: Schema.NullOr(Schema.String),
  repoIds: Schema.Array(RepoId),
  inputHashes: Schema.Array(InputHash),
  state: BatchState,
  leaseUntil: Schema.DateTimeUtcFromMillis,
});
export type Manifest = typeof Manifest.Type;

export type NewManifest = Omit<Manifest, "providerBatchId" | "state">;

export interface Queries {
  // Writes a manifest before its request is sent. The caller takes the repos' lease in the same transaction.
  readonly prepareBatch: (manifest: NewManifest) => Effect.Effect<void, DbQueryFailed>;
  // Records the provider's name for a sent request. A request with no provider batch, on the CLI, records null.
  readonly submittedBatch: (input: {
    readonly id: BatchId;
    readonly providerBatchId: string | null;
  }) => Effect.Effect<void, DbQueryFailed>;
  // Every manifest a run left prepared or submitted, oldest first.
  readonly openBatches: Effect.Effect<ReadonlyArray<Manifest>, DbQueryFailed | DbRowInvalid>;
  // Moves a manifest's lease to until, with every repo that still holds it, in one statement, and returns those repos:
  // the items that still owe an answer. A repo whose lease ran out and that another attempt took is not one of them.
  readonly extendBatch: (input: {
    readonly manifest: Manifest;
    readonly until: DateTime.Utc;
  }) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  // Marks a manifest captured once no repo holds its lease, and says whether it did.
  readonly closeBatch: (manifest: Manifest) => Effect.Effect<boolean, DbQueryFailed | DbRowInvalid>;
  // Gives back the lease of every repo that still holds it, and deletes the manifest when nothing was ever sent for it,
  // or marks it abandoned when a provider batch exists that can no longer be read.
  readonly dropBatch: (manifest: Manifest) => Effect.Effect<void, DbQueryFailed>;
}

const decodeManifests = rowsDecoder(Manifest);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeClosed = rowsDecoder(Schema.Struct({ id: BatchId }));

const manifestColumns = sql`id, adapter, model, recipe, request_key as "requestKey", request_object as "requestObject",
  provider_batch_id as "providerBatchId", array(select unnest(repo_ids)::float8) as "repoIds",
  input_hashes as "inputHashes", state, (extract(epoch from lease_until) * 1000)::bigint::float8 as "leaseUntil"`;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);

  return {
    prepareBatch: (manifest) =>
      execute(
        "knowledge.prepareBatch",
        sql`insert into extraction_batches (id, adapter, model, recipe, request_key, request_object, repo_ids,
            input_hashes, lease_until)
          values (${manifest.id}, ${manifest.adapter}, ${manifest.model}, ${manifest.recipe}, ${manifest.requestKey},
            ${manifest.requestObject}, ${sql.param([...manifest.repoIds])}::bigint[],
            ${sql.param([...manifest.inputHashes])}::text[], ${timeParam(manifest.leaseUntil)})`,
      ),
    submittedBatch: ({ id, providerBatchId }) =>
      execute(
        "knowledge.submittedBatch",
        sql`update extraction_batches set state = 'submitted', provider_batch_id = ${providerBatchId}, updated_at = now()
          where id = ${id} and state in ('prepared', 'submitted')`,
      ),
    openBatches: query(
      "knowledge.openBatches",
      decodeManifests,
      sql`select ${manifestColumns} from extraction_batches where state in ('prepared', 'submitted')
        order by created_at, id`,
    ),
    extendBatch: ({ manifest, until }) =>
      query(
        "knowledge.extendBatch",
        decodeIds,
        sql`with held as (
            update repos set enrich_retry_at = ${timeParam(until)}
            where id in (${lockedRepoIds(manifest.repoIds)}) and enrich_retry_at = ${timeParam(manifest.leaseUntil)}
            returning id
          ),
          moved as (
            update extraction_batches set lease_until = ${timeParam(until)}, updated_at = now()
            where id = ${manifest.id} and lease_until = ${timeParam(manifest.leaseUntil)}
          )
          select id::float8 as id from held order by id`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    closeBatch: (manifest) =>
      query(
        "knowledge.closeBatch",
        decodeClosed,
        sql`update extraction_batches set state = 'captured', updated_at = now()
          where id = ${manifest.id} and state in ('prepared', 'submitted')
            and not exists (
              select 1 from repos r
              where r.id = any(extraction_batches.repo_ids) and r.enrich_retry_at = extraction_batches.lease_until
            )
          returning id`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    dropBatch: (manifest) =>
      execute(
        "knowledge.dropBatch",
        sql`with released as (
            update repos set enrich_retry_at = null
            where id in (${lockedRepoIds(manifest.repoIds)}) and enrich_retry_at = ${timeParam(manifest.leaseUntil)}
          ),
          unsent as (
            delete from extraction_batches where id = ${manifest.id} and provider_batch_id is null
              and state = 'prepared'
          )
          update extraction_batches set state = 'abandoned', updated_at = now()
          where id = ${manifest.id} and (provider_batch_id is not null or state = 'submitted')`,
      ),
  } satisfies Queries;
});
