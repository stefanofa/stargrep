import { type ObjectId, RepoId } from "@stargrep/github/schemas";
import type { Claim, DroppedItem, Lanes } from "@stargrep/knowledge/claims";
import { type BatchId, type InputHash, ReceiptId } from "@stargrep/knowledge/ids";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../../errors.ts";
import { lockedRepoIds } from "../../lock-order.ts";
import * as Postgres from "../../postgres.ts";
import { json, rowsDecoder, statements } from "../../rows.ts";
import { type receiptSource, repos, unreadEnrichment } from "../../schema.ts";
import { sharedLock } from "./lock.ts";

export type ReceiptSource = (typeof receiptSource.enumValues)[number];

// One model or stand-in answer, as commit A saves it.
export interface Answer {
  readonly receiptId: ReceiptId;
  readonly repoId: RepoId;
  readonly source: ReceiptSource;
  readonly inputHash: InputHash;
  // The README the answer describes. Capture saves the summary only while the repo still has it.
  readonly readmeOid: ObjectId | null;
  readonly recipe: number;
  readonly model: string;
  readonly batchId: BatchId | null;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly claims: ReadonlyArray<Claim>;
  readonly lanes: Lanes;
  readonly dropped: ReadonlyArray<DroppedItem>;
  readonly rawKey: string | null;
  // The enrichment lease the attempt that paid for the answer holds, by its end time. Capture clears only that lease,
  // so a late answer never frees a repo a later attempt holds.
  readonly lease: DateTime.Utc | null;
}

// receiptId is the answer the repo points at: the one captured, or the receipt an earlier capture of the same source,
// input, and recipe already committed. saved is false when the repo's README or inputs moved on, or it is gone.
// summary and keywords are that receipt's, which the repo shows once saved.
export interface Captured {
  readonly repoId: RepoId;
  readonly receiptId: ReceiptId;
  readonly saved: boolean;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
}

export interface Queries {
  // Commit A: receipts, then the summary of every repo whose README and inputs still match and that is not gone. An
  // answer with no facets list keeps the claims of the receipt the repo points at. The lease each answer names is
  // cleared, saved or not. The trigger on receipt_id marks the repo stale. The answers must name distinct repos, and an
  // answer for a repo with no row is left out.
  readonly capture: (
    answers: ReadonlyArray<Answer>,
  ) => Effect.Effect<ReadonlyArray<Captured>, DbQueryFailed | DbRowInvalid>;
}

const decodeCaptured = rowsDecoder(
  Schema.Struct({
    repoId: RepoId,
    receiptId: ReceiptId,
    saved: Schema.Boolean,
    summary: Schema.String,
    keywords: Schema.Array(Schema.String),
  }),
);

const keepsEmbedding = sql`not ${unreadEnrichment(repos)}`;

const withLeaseText = (answer: Answer) => ({
  ...answer,
  lease: answer.lease === null ? null : DateTime.formatIso(answer.lease),
});

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);

  const capture = (answers: ReadonlyArray<Answer>) =>
    withTransaction(
      Effect.gen(function* () {
        // Shared first, as projection takes it, so no mint's invalidation marks repo_facets rows while this commit's
        // receipt_id trigger marks them too.
        yield* execute("knowledge.capture", sharedLock);
        yield* execute("knowledge.capture", lockedRepoIds(answers.map((answer) => answer.repoId)));
        return yield* query(
          "knowledge.capture",
          decodeCaptured,
          sql`
            with answer as (
              select a.*, not exists (select 1 from jsonb_each_text(a.lanes) l where l.value <> 'missing') as unanswered
              from jsonb_to_recordset(${json(answers.map(withLeaseText))}) as a (
                "receiptId" uuid, "repoId" bigint, source receipt_source, "inputHash" text, "readmeOid" text,
                recipe integer, model text, "batchId" uuid, summary text, keywords jsonb, claims jsonb, lanes jsonb,
                dropped jsonb, "rawKey" text, lease timestamptz
              )
              where exists (select 1 from repos r where r.id = a."repoId")
            ),
            -- An answer with no list at all keeps the claims of the receipt the repo points at and names it, so a model
            -- that left the field out does not wipe the repo's facets. An empty list is an answer, and is kept as one.
            previous as (
              select r.id as repo_id, c.id, c.claims
              from repos r join receipts c on c.id = r.receipt_id
              where r.id in (select "repoId" from answer)
            ),
            inserted as (
              insert into receipts (id, repo_id, source, input_hash, recipe, model, batch_id, summary, keywords, claims,
                lanes, dropped, carried_from, raw_key)
              select a."receiptId", a."repoId", a.source, a."inputHash", a.recipe, a.model, a."batchId", a.summary,
                a.keywords, case when a.unanswered and p.id is not null then p.claims else a.claims end, a.lanes,
                a.dropped, case when a.unanswered then p.id end, a."rawKey"
              from answer a left join previous p on p.repo_id = a."repoId"
              on conflict (repo_id, source, input_hash, recipe) do nothing
              returning id, repo_id, claims
            ),
            -- A retried answer converges on the receipt committed first, text and claims included, so the repo always
            -- shows the answer its receipt holds.
            winner as (
              select a."repoId", a."readmeOid", a."inputHash", a.recipe, a.lease, i.id as receipt_id, a.summary,
                a.keywords, i.claims
              from answer a join inserted i on i.id = a."receiptId"
              union all
              select a."repoId", a."readmeOid", a."inputHash", a.recipe, a.lease, r.id, r.summary, r.keywords, r.claims
              from answer a join receipts r
                on (r.repo_id, r.source, r.input_hash, r.recipe) = (a."repoId", a.source, a."inputHash", a.recipe)
            ),
            -- A new summary of the README a read repo's summary describes keeps the old embedding, marked stale, so the
            -- repo stays read and searchable until the new embedding replaces it.
            saved as (
              update repos set
                summary = w.summary,
                keywords = w.keywords,
                summary_readme_oid = w."readmeOid",
                summary_recipe = w.recipe,
                summary_input_hash = w."inputHash",
                receipt_id = w.receipt_id,
                enrich_retry_at = case when repos.enrich_retry_at = w.lease then null else repos.enrich_retry_at end,
                embedding = case when ${keepsEmbedding} then repos.embedding end,
                embedding_model = case when ${keepsEmbedding} then repos.embedding_model end,
                embedding_stale = ${keepsEmbedding}
              from winner w
              where repos.id = w."repoId"
                and repos.readme_oid is not distinct from w."readmeOid"
                and repos.input_hash = w."inputHash"
                and repos.gone_at is null
              returning repos.id
            ),
            released as (
              update repos set enrich_retry_at = null
              from winner w
              where repos.id = w."repoId" and repos.enrich_retry_at = w.lease
                and not exists (select 1 from saved s where s.id = w."repoId")
            )
            select w."repoId"::float8 as "repoId", w.receipt_id as "receiptId",
              exists (select 1 from saved s where s.id = w."repoId") as saved, w.summary, w.keywords
            from winner w
            order by w."repoId"`,
        );
      }),
    );

  return {
    capture: (answers) => (answers.length === 0 ? Effect.succeed([]) : capture(answers)),
  } satisfies Queries;
});
