import { RepoId } from "@stargrep/github/schemas";
import { BatchId, InputHash } from "@stargrep/knowledge/ids";
import { sql } from "drizzle-orm";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
// settles their item, or a fallback manifest takes it over, so the lease is each item's state and nothing else is.
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
  retryOf: Schema.NullOr(BatchId),
});
export type Manifest = typeof Manifest.Type;

export type NewManifest = Omit<Manifest, "providerBatchId" | "state">;

// The driver that holds the prefill, at a moment of its clock.
export interface Ownership {
  readonly owner: string;
  readonly now: DateTime.Utc;
}

export interface Queries {
  // Writes a manifest before its request is sent, and returns its ID. A closed manifest with the same request key, such
  // as one whose items all failed and were given back, is reopened in place with this one's items and lease, so the
  // same request never needs a second row. None means an open manifest already holds the key. The caller takes the
  // repos' lease in the same transaction.
  readonly prepareBatch: (manifest: NewManifest) => Effect.Effect<Option.Option<BatchId>, DbQueryFailed | DbRowInvalid>;
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
  // Hands the repos that still hold one lease to another, such as a fallback manifest's, and returns the ones it moved.
  readonly moveLease: (input: {
    readonly ids: ReadonlyArray<RepoId>;
    readonly from: DateTime.Utc;
    readonly to: DateTime.Utc;
  }) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  // Marks a manifest captured once no repo holds its lease, and says whether it did.
  readonly closeBatch: (manifest: Manifest) => Effect.Effect<boolean, DbQueryFailed | DbRowInvalid>;
  // Deletes a manifest that was never sent and gives back its repos' leases, but only while owner holds the prefill.
  // A manifest that may have been sent is never dropped, so its paid answers stay recoverable. Says whether it dropped.
  readonly dropBatch: (input: {
    readonly manifest: Manifest;
    readonly owner: string;
  }) => Effect.Effect<boolean, DbQueryFailed | DbRowInvalid>;
  // Claims the prefill for owner when nobody holds it, owner already does, or the holder's heartbeat is before stale.
  readonly claimPrefill: (
    input: Ownership & { readonly stale: DateTime.Utc },
  ) => Effect.Effect<boolean, DbQueryFailed | DbRowInvalid>;
  // Renews owner's heartbeat, and says whether owner still holds the prefill.
  readonly heartbeatPrefill: (input: Ownership) => Effect.Effect<boolean, DbQueryFailed | DbRowInvalid>;
  readonly releasePrefill: (owner: string) => Effect.Effect<void, DbQueryFailed>;
}

const decodeManifests = rowsDecoder(Manifest);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeBatchIds = rowsDecoder(Schema.Struct({ id: BatchId }));
const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const decodeOwners = rowsDecoder(Schema.Struct({ owner: Schema.String }));

const manifestColumns = sql`id, adapter, model, recipe, request_key as "requestKey", request_object as "requestObject",
  provider_batch_id as "providerBatchId", array(select unnest(repo_ids)::float8) as "repoIds",
  input_hashes as "inputHashes", state, (extract(epoch from lease_until) * 1000)::bigint::float8 as "leaseUntil",
  retry_of as "retryOf"`;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);

  return {
    prepareBatch: (manifest) =>
      query(
        "knowledge.prepareBatch",
        decodeBatchIds,
        sql`insert into extraction_batches (id, adapter, model, recipe, request_key, request_object, repo_ids,
            input_hashes, lease_until, retry_of)
          values (${manifest.id}, ${manifest.adapter}, ${manifest.model}, ${manifest.recipe}, ${manifest.requestKey},
            ${manifest.requestObject}, ${sql.param([...manifest.repoIds])}::bigint[],
            ${sql.param([...manifest.inputHashes])}::text[], ${timeParam(manifest.leaseUntil)}, ${manifest.retryOf}::uuid)
          on conflict (request_key) do update set
            state = 'prepared', provider_batch_id = null, adapter = excluded.adapter, model = excluded.model,
            recipe = excluded.recipe, request_object = excluded.request_object, repo_ids = excluded.repo_ids,
            input_hashes = excluded.input_hashes, lease_until = excluded.lease_until, retry_of = excluded.retry_of,
            updated_at = now()
          where extraction_batches.state in ('captured', 'abandoned')
          returning id`,
      ).pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.id))),
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
    moveLease: ({ ids, from, to }) =>
      query(
        "knowledge.moveLease",
        decodeIds,
        sql`update repos set enrich_retry_at = ${timeParam(to)}
          where id in (${lockedRepoIds(ids)}) and enrich_retry_at = ${timeParam(from)}
          returning id::float8 as id`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    closeBatch: (manifest) =>
      query(
        "knowledge.closeBatch",
        decodeBatchIds,
        sql`update extraction_batches set state = 'captured', updated_at = now()
          where id = ${manifest.id} and state in ('prepared', 'submitted')
            and not exists (
              select 1 from repos r
              where r.id = any(extraction_batches.repo_ids) and r.enrich_retry_at = extraction_batches.lease_until
            )
          returning id`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    dropBatch: ({ manifest, owner }) =>
      query(
        "knowledge.dropBatch",
        decodeCount,
        sql`with dropped as (
            delete from extraction_batches
            where id = ${manifest.id} and state = 'prepared' and provider_batch_id is null
              and exists (select 1 from prefill_owner where owner = ${owner}::uuid)
            returning id
          ),
          released as (
            update repos set enrich_retry_at = null
            where id in (${lockedRepoIds(manifest.repoIds)}) and enrich_retry_at = ${timeParam(manifest.leaseUntil)}
              and exists (select 1 from dropped)
          )
          select count(*)::int as count from dropped`,
      ).pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0)),
    claimPrefill: ({ owner, now, stale }) =>
      query(
        "knowledge.claimPrefill",
        decodeOwners,
        sql`insert into prefill_owner (singleton, owner, heartbeat_at) values (true, ${owner}::uuid, ${timeParam(now)})
          on conflict (singleton) do update set owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
          where prefill_owner.owner = excluded.owner or prefill_owner.heartbeat_at < ${timeParam(stale)}
          returning owner::text as owner`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    heartbeatPrefill: ({ owner, now }) =>
      query(
        "knowledge.heartbeatPrefill",
        decodeOwners,
        sql`update prefill_owner set heartbeat_at = ${timeParam(now)} where owner = ${owner}::uuid
          returning owner::text as owner`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    releasePrefill: (owner) =>
      execute("knowledge.releasePrefill", sql`delete from prefill_owner where owner = ${owner}::uuid`),
  } satisfies Queries;
});
