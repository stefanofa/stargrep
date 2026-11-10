import { ObjectId, RepoId } from "@stargrep/github/schemas";
import type { FacetRef } from "@stargrep/knowledge/atom";
import { Claim, type DroppedItem, type Lanes } from "@stargrep/knowledge/claims";
import type { Change } from "@stargrep/knowledge/curation";
import * as Decisions from "@stargrep/knowledge/decisions";
import { type BatchId, type InputHash, ReceiptId, Revision, SubjectId } from "@stargrep/knowledge/ids";
import { LabelKey } from "@stargrep/knowledge/label-key";
import { type ClaimVerdict, kindKeys } from "@stargrep/knowledge/projection";
import type { Dim, RoleId } from "@stargrep/knowledge/registry";
import { type SQL, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type DbQueryFailed, type DbRowInvalid, KeyMinted, type Operation, StaleRevision } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { resultRows, rowsDecoder } from "../rows.ts";
import {
  atomColumns,
  type decisionKind,
  type receiptSource,
  repos,
  type subjectStatus,
  unreadEnrichment,
} from "../schema.ts";

// Nothing writes a private namespace yet, so every vocabulary write here is public.
const namespace = "public";

// One advisory lock per namespace guards the vocabulary. Mints and decisions take it exclusively, and projections take
// it shared, so a vocabulary change waits for every projection in flight and then marks the rows they wrote.
const lockKey = sql`hashtextextended(${`stargrep:knowledge:${namespace}`}, 0)`;
const exclusiveLock = sql`select pg_advisory_xact_lock(${lockKey})`;
const sharedLock = sql`select pg_advisory_xact_lock_shared(${lockKey})`;

export type ReceiptSource = (typeof receiptSource.enumValues)[number];
export type DecisionKind = (typeof decisionKind.enumValues)[number];
export type SubjectStatus = (typeof subjectStatus.enumValues)[number];

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

export interface MintClaim {
  readonly key: LabelKey;
  // The surface form the new subject is labelled with.
  readonly label: string;
  readonly receiptId: ReceiptId;
}

export interface Minted {
  readonly minted: ReadonlyArray<{ readonly key: LabelKey; readonly subjectId: SubjectId }>;
  readonly invalidated: number;
}

export interface Label {
  readonly key: LabelKey;
  readonly subjectId: SubjectId;
  readonly isDefault: boolean;
  readonly source: "minted" | "decision";
}

// A repo as projection reads it, locked until the projection commits: its name, its GitHub facts, and its receipt's
// claims.
export interface LockedRepo {
  readonly id: RepoId;
  readonly owner: string;
  readonly name: string;
  // The receipt the claims came from. When a writer moved receipt_id while this read waited on the row, Postgres
  // re-reads the row but not the receipt, so this differs from the row's receipt_id and the write guard skips the repo.
  readonly receiptId: ReceiptId | null;
  readonly language: string | null;
  readonly license: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly claims: ReadonlyArray<Claim>;
}

export interface StoredAtom {
  readonly role: RoleId;
  readonly value: FacetRef;
}

export interface Projection {
  readonly repoId: RepoId;
  // The receipt projected. Nothing is written when the repo points at another one by now.
  readonly receiptId: ReceiptId | null;
  readonly atoms: ReadonlyArray<StoredAtom>;
  // Label keys looked up and not found, so a later label for one of them marks the repo stale.
  readonly unresolvedKeys: ReadonlyArray<LabelKey>;
  // Why each claim was used or dropped, kept on the receipt.
  readonly verdicts: ReadonlyArray<ClaimVerdict>;
}

export interface Projected {
  readonly projected: number;
  readonly skipped: number;
}

export interface Invalidation {
  readonly keys: ReadonlyArray<LabelKey>;
  readonly subjects: ReadonlyArray<SubjectId>;
}

// The derived rows a run of decisions changes, as the fold computes them against the log at the expected revision.
// Every revision is explicit: a new row names the decision that owns it, which an undo may name instead of itself.
// Only decision rows change. Projection's minted labels stay.
export type VocabularyChange = Change;

export const noChange: VocabularyChange = {
  created: [],
  presented: [],
  labelsAdded: [],
  labelsRemoved: [],
  merged: [],
  unmerged: [],
  edgesAdded: [],
  edgesRemoved: [],
  refresh: [],
  invalidate: { keys: [], subjects: [], repos: [] },
};

export interface DecisionRow {
  readonly kind: DecisionKind;
  // The decision as the Decision schema in packages/knowledge encodes it, plus created, the subject a Create or Split
  // made, and base, a minted subject's label before its first Rename. decisions reads them back for the fold.
  readonly payload: { readonly _tag: string; readonly [field: string]: Schema.Json };
  readonly undoes: Revision | null;
  readonly actor: string;
  readonly reason: string;
}

export interface Decision {
  // The head revision the caller computed the change against. The rows take the revisions after it, in order.
  readonly expected: Revision;
  readonly rows: ReadonlyArray<DecisionRow>;
  readonly change: VocabularyChange;
}

export interface Decided {
  // The last row's revision, the new head.
  readonly revision: Revision;
  readonly invalidated: number;
}

// A subject as curation reads it, resolved through its merge.
export interface SubjectInfo {
  readonly id: SubjectId;
  readonly label: string;
  readonly definition: string | null;
  readonly status: SubjectStatus;
  readonly repoCount: number;
  readonly canonicalId: SubjectId;
}

// How many live repos one impact reaches: those whose stored arrays hold one of its subjects, whose unresolved keys
// hold one of its keys, or that it names.
export interface Reach {
  readonly keys: ReadonlyArray<LabelKey>;
  readonly subjects: ReadonlyArray<SubjectId>;
  readonly repos: ReadonlyArray<number>;
}

// Two labels whose keys differ only by spelling, each resolved to its canonical subject.
export interface Variant {
  readonly channel: "separator" | "plural" | "js";
  readonly a: { readonly key: LabelKey; readonly subjectId: SubjectId };
  readonly b: { readonly key: LabelKey; readonly subjectId: SubjectId };
}

// What a legacy receipt copies from the repo's summary columns.
export interface LegacyContent {
  readonly recipe: number;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
}

// A repo with a summary from before receipts, as the legacy backfill reads it, locked until the page commits: the facts
// its input hash names, the legacy columns, and the legacy receipt it points at, if any.
export interface LegacyRepo {
  readonly id: RepoId;
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly language: string | null;
  readonly summaryReadmeOid: ObjectId | null;
  readonly summaryRecipe: number;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind: string | null;
  readonly current: LegacyContent | null;
}

export interface LegacyAnswer extends LegacyContent {
  readonly repoId: RepoId;
  readonly inputHash: InputHash;
  readonly claims: ReadonlyArray<Claim>;
  readonly lanes: Lanes;
  readonly dropped: ReadonlyArray<DroppedItem>;
}

export interface KeptLegacy {
  // How many repos the page read, and the last of them, which the next page starts after.
  readonly read: number;
  readonly last: RepoId | null;
  readonly inserted: number;
  readonly pointed: number;
}

// The only writer of the knowledge tables. Capture saves answers, mint and decide change the vocabulary, and project
// writes the atoms, each under the lock protocol above.
export interface Queries {
  // Commit A: receipts, then the summary of every repo whose README and inputs still match and that is not gone, with
  // the legacy kind column set from the receipt's primary kind. An answer with no facets list keeps the claims of the
  // receipt the repo points at. The lease each answer names is cleared, saved or not. The trigger on receipt_id marks
  // the repo stale. The answers must name distinct repos, and an answer for a repo with no row is left out.
  readonly capture: (
    answers: ReadonlyArray<Answer>,
  ) => Effect.Effect<ReadonlyArray<Captured>, DbQueryFailed | DbRowInvalid>;
  // Commit B, step 1: a subject, its minted default label, and its own two subject_matches rows for every key no label
  // has yet, then marks stale the repos that looked one of those keys up and found nothing.
  readonly mint: (claims: ReadonlyArray<MintClaim>) => Effect.Effect<Minted, DbQueryFailed | DbRowInvalid>;
  // The labels resolution reads, from knowledge_labels.
  readonly labels: (keys: ReadonlyArray<LabelKey>) => Effect.Effect<ReadonlyArray<Label>, DbQueryFailed | DbRowInvalid>;
  // Commit B, step 2: under the shared lock, locks the live repos for no key update in ID order, hands them and the
  // head revision to compute, and writes each projection's closed arrays, facets row, and verdicts where the repo
  // still points at the receipt projected. A repo compute returns no projection for stays stale. The closed arrays are
  // written only where they changed, so a projection that changes no closed atom leaves the repos row untouched.
  readonly project: <E, R>(
    repoIds: ReadonlyArray<RepoId>,
    compute: (repos: ReadonlyArray<LockedRepo>, revision: Revision) => Effect.Effect<ReadonlyArray<Projection>, E, R>,
  ) => Effect.Effect<Projected, E | DbQueryFailed | DbRowInvalid, R>;
  // The public curation log in revision order.
  readonly decisions: Effect.Effect<ReadonlyArray<Decisions.StoredDecision>, DbQueryFailed | DbRowInvalid>;
  // The rows projection replays for its rules: merges, splits, corrections, and undos.
  readonly rules: Effect.Effect<ReadonlyArray<Decisions.StoredDecision>, DbQueryFailed | DbRowInvalid>;
  readonly stale: (limit: number) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly invalidate: (invalidation: Invalidation) => Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // The nightly count behind listing. Returns how many subjects changed.
  readonly count: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // The nightly count of each closed value's bare key, which lookups read. Returns how many rows changed.
  readonly countAtoms: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // Fresh subject IDs for a decision that creates subjects, so its payload can name them.
  readonly allocate: (count: number) => Effect.Effect<ReadonlyArray<SubjectId>, DbQueryFailed | DbRowInvalid>;
  readonly revision: Effect.Effect<Revision, DbQueryFailed | DbRowInvalid>;
  // Under the exclusive lock, appends the rows at the revisions after the expected one, applies their change, rebuilds
  // the subject_matches rows of the subjects it touches and their ancestors, and marks stale the repos its invalidation
  // names, along with the holders of a minted key a new decision label now outranks. Fails with StaleRevision when the
  // log moved past the expected revision, and with KeyMinted when a new row gives a subject a key projection minted
  // for another one.
  readonly decide: (
    decision: Decision,
  ) => Effect.Effect<Decided, StaleRevision | KeyMinted | DbQueryFailed | DbRowInvalid>;
  // Subjects by ID, for the labels a Rename replaces and the holders a seed adopts.
  readonly subjects: (
    ids: ReadonlyArray<SubjectId>,
  ) => Effect.Effect<ReadonlyArray<SubjectInfo>, DbQueryFailed | DbRowInvalid>;
  // The minted default holder of each key that has one.
  readonly minted: (
    keys: ReadonlyArray<LabelKey>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: LabelKey; readonly subjectId: SubjectId }>,
    DbQueryFailed | DbRowInvalid
  >;
  // How many live repos each impact reaches, in order.
  readonly reach: (impacts: ReadonlyArray<Reach>) => Effect.Effect<ReadonlyArray<number>, DbQueryFailed | DbRowInvalid>;
  // Up to limit live repos a filter on each subject matches, for previews and proposals.
  readonly examples: (
    ids: ReadonlyArray<SubjectId>,
    limit: number,
  ) => Effect.Effect<ReadonlyMap<SubjectId, ReadonlyArray<RepoId>>, DbQueryFailed | DbRowInvalid>;
  // Candidates the usage floor accepts: canonical public subjects on at least three repos, by the last count, whose
  // repos have at least two owners.
  readonly floor: Effect.Effect<ReadonlyArray<SubjectId>, DbQueryFailed | DbRowInvalid>;
  // Label pairs whose keys differ by a separator, a plural s, or a js suffix, resolved to two different live subjects,
  // keys of three characters or fewer left out.
  readonly variants: Effect.Effect<ReadonlyArray<Variant>, DbQueryFailed | DbRowInvalid>;
  // One page of the legacy backfill: under the shared lock, locks the next live repos with a summary after the given ID
  // whose receipt is legacy or missing, in ID order, hands them to build, and keeps each answer it returns as a legacy
  // receipt the repo points at. A second answer with the same input hash and recipe keeps the first receipt.
  readonly keepLegacy: <E, R>(
    page: { readonly after: number; readonly limit: number },
    build: (repos: ReadonlyArray<LegacyRepo>) => Effect.Effect<ReadonlyArray<LegacyAnswer>, E, R>,
  ) => Effect.Effect<KeptLegacy, E | DbQueryFailed | DbRowInvalid, R>;
}

const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

const columnsOf = (role: RoleId): Partial<Record<Dim, string>> => atomColumns[role];

const closedTypes: Readonly<Record<Exclude<Dim, "subject">, string>> = {
  kind: "knowledge_kind[]",
  language: "knowledge_language[]",
  license: "knowledge_license[]",
  platform: "knowledge_platform[]",
  status: "knowledge_status[]",
};

const storedColumns = Object.keys(atomColumns).flatMap((role) =>
  Object.entries(columnsOf(role as RoleId)).map(([dim, column]) => ({
    column,
    type: dim === "subject" ? "bigint[]" : closedTypes[dim as Exclude<Dim, "subject">],
    closed: dim !== "subject",
  })),
);
const closedColumns = storedColumns.filter((stored) => stored.closed).map((stored) => stored.column);
const subjectColumns = storedColumns.filter((stored) => !stored.closed).map((stored) => stored.column);

// Each projection as one record of column arrays, in the order its atoms came.
const projectionRecord = (projection: Projection) => {
  const record: Record<string, Array<string | number>> = Object.fromEntries(
    storedColumns.map(({ column }) => [column, []]),
  );
  for (const atom of projection.atoms) {
    const column = columnsOf(atom.role)[atom.value.dim];
    if (column === undefined) throw new Error(`role ${atom.role} has no ${atom.value.dim} column`);
    record[column]?.push(atom.value.id);
  }
  return {
    ...record,
    repo_id: projection.repoId,
    receipt_id: projection.receiptId,
    unresolved_keys: projection.unresolvedKeys,
    verdicts: projection.verdicts,
  };
};

const identifiers = (columns: ReadonlyArray<string>) => sql.raw(columns.join(", "));
const assignments = (columns: ReadonlyArray<string>, from: string) =>
  sql.raw(columns.map((column) => `${column} = ${from}.${column}`).join(", "));
const projectionColumns = sql.raw(
  [
    "repo_id bigint",
    "receipt_id uuid",
    ...storedColumns.map(({ column, type }) => `${column} ${type}`),
    "unresolved_keys text[]",
    "verdicts jsonb",
  ].join(", "),
);

const decodeCaptured = rowsDecoder(
  Schema.Struct({
    repoId: RepoId,
    receiptId: ReceiptId,
    saved: Schema.Boolean,
    summary: Schema.String,
    keywords: Schema.Array(Schema.String),
  }),
);
const decodeMinted = rowsDecoder(Schema.Struct({ key: LabelKey, subjectId: SubjectId }));
const decodeLabels = rowsDecoder(
  Schema.Struct({
    key: LabelKey,
    subjectId: SubjectId,
    isDefault: Schema.Boolean,
    source: Schema.Literals(["minted", "decision"]),
  }),
);
const decodeLocked = rowsDecoder(
  Schema.Struct({
    id: RepoId,
    owner: Schema.String,
    name: Schema.String,
    receiptId: Schema.NullOr(ReceiptId),
    language: Schema.NullOr(Schema.String),
    license: Schema.NullOr(Schema.String),
    topics: Schema.Array(Schema.String),
    claims: Schema.Array(Claim),
  }),
);
const decodeDecisions = rowsDecoder(
  Schema.Struct({
    revision: Revision,
    decision: Decisions.Decision,
    created: Schema.NullOr(SubjectId),
    base: Schema.NullOr(Schema.String),
  }),
);
const decodeTaken = rowsDecoder(Schema.Struct({ key: Schema.String, subjectId: Schema.Int, holder: Schema.Int }));
const decodeSubjects = rowsDecoder(
  Schema.Struct({
    id: SubjectId,
    label: Schema.String,
    definition: Schema.NullOr(Schema.String),
    status: Schema.Literals(["candidate", "accepted", "rejected"]),
    repoCount: Schema.Int,
    canonicalId: SubjectId,
  }),
);
const decodeKeyHolders = rowsDecoder(Schema.Struct({ key: LabelKey, subjectId: SubjectId }));
const decodeReach = rowsDecoder(Schema.Struct({ repos: Schema.Int }));
const decodeExamples = rowsDecoder(Schema.Struct({ subjectId: SubjectId, repos: Schema.Array(RepoId) }));
const Side = Schema.Struct({ key: LabelKey, subjectId: SubjectId });
const decodeVariants = rowsDecoder(
  Schema.Struct({ channel: Schema.Literals(["separator", "plural", "js"]), a: Side, b: Side }),
);
const LegacyContentRow = Schema.Struct({
  recipe: Schema.Int,
  summary: Schema.String,
  keywords: Schema.Array(Schema.String),
});
const decodeLegacy = rowsDecoder(
  Schema.Struct({
    id: RepoId,
    owner: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    topics: Schema.Array(Schema.String),
    language: Schema.NullOr(Schema.String),
    summaryReadmeOid: Schema.NullOr(ObjectId),
    summaryRecipe: Schema.Int,
    summary: Schema.String,
    keywords: Schema.Array(Schema.String),
    kind: Schema.NullOr(Schema.String),
    current: Schema.NullOr(LegacyContentRow),
  }),
);
const decodeKept = rowsDecoder(Schema.Struct({ inserted: Schema.Int, pointed: Schema.Int }));
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeSubjectIds = rowsDecoder(Schema.Struct({ id: SubjectId }));
const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const decodeRevision = rowsDecoder(Schema.Struct({ revision: Revision }));

const only = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => Effect.orDie(Effect.fromNullishOr(rows[0]));

const keepsEmbedding = sql`not ${unreadEnrichment(repos)}`;

const withLeaseText = (answer: Answer) => ({
  ...answer,
  lease: answer.lease === null ? null : DateTime.formatIso(answer.lease),
});

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;

  const query = <A>(
    operation: Operation,
    decode: (operation: Operation) => (rows: unknown) => Effect.Effect<A, DbRowInvalid>,
    statement: SQL,
  ) =>
    run(operation, (db) => db.execute(statement)).pipe(
      Effect.flatMap((result) => decode(operation)(resultRows(result))),
    );
  const execute = (operation: Operation, statement: SQL) =>
    run(operation, (db) => db.execute(statement)).pipe(Effect.asVoid);

  const head = query(
    "knowledge.revision",
    decodeRevision,
    sql`select coalesce(max(revision), 0)::integer as revision from decisions where namespace = ${namespace}`,
  ).pipe(
    Effect.flatMap(only),
    Effect.map((row) => row.revision),
  );

  const invalidated = (operation: Operation, invalidation: Invalidation) =>
    query(
      operation,
      decodeCount,
      sql`select knowledge_invalidate(${sql.param([...invalidation.keys])}::text[], ${sql.param([...invalidation.subjects])}::bigint[]) as count`,
    ).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    );

  const capture = (answers: ReadonlyArray<Answer>) =>
    withTransaction(
      Effect.gen(function* () {
        // Shared first, as projection takes it, so no mint's invalidation marks repo_facets rows while this commit's
        // receipt_id trigger marks them too.
        yield* execute("knowledge.capture", sharedLock);
        const ids = answers.map((answer) => answer.repoId).sort((a, b) => a - b);
        yield* execute(
          "knowledge.capture",
          sql`select id from repos where id = any(${sql.param(ids)}::bigint[]) order by id for no key update`,
        );
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
            -- The legacy kind column holds the receipt's primary kind, as primaryKind reads it, until the dual write
            -- goes: the first is claim whose key names a kind, or none. Every reader uses kinds.
            kinded as (
              select w.*, (
                select k.kind
                from jsonb_array_elements(w.claims) c join jsonb_each_text(${json(Object.fromEntries(kindKeys))}) as k (key, kind)
                  on k.key = c ->> 'key'
                where c ->> 'role' = 'is'
                order by (c ->> 'ordinal')::integer
                limit 1
              ) as kind
              from winner w
            ),
            -- A new summary of the README a read repo's summary describes keeps the old embedding, marked stale, so the
            -- repo stays read and searchable until the new embedding replaces it.
            saved as (
              update repos set
                summary = w.summary,
                keywords = w.keywords,
                kind = w.kind,
                summary_readme_oid = w."readmeOid",
                summary_recipe = w.recipe,
                summary_input_hash = w."inputHash",
                receipt_id = w.receipt_id,
                enrich_retry_at = case when repos.enrich_retry_at = w.lease then null else repos.enrich_retry_at end,
                embedding = case when ${keepsEmbedding} then repos.embedding end,
                embedding_model = case when ${keepsEmbedding} then repos.embedding_model end,
                embedding_stale = ${keepsEmbedding}
              from kinded w
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

  const mint = (claims: ReadonlyArray<MintClaim>) =>
    withTransaction(
      Effect.gen(function* () {
        yield* execute("knowledge.mint", exclusiveLock);
        const minted = yield* query(
          "knowledge.mint",
          decodeMinted,
          sql`
            with wanted as (
              select distinct on (c.key) c.key, c.label, c.receipt_id
              from unnest(
                ${sql.param(claims.map((claim) => claim.key))}::text[],
                ${sql.param(claims.map((claim) => claim.label))}::text[],
                ${sql.param(claims.map((claim) => claim.receiptId))}::uuid[]
              ) as c (key, label, receipt_id)
              where not exists (select 1 from knowledge_labels l where l.namespace = ${namespace} and l.key = c.key)
              order by c.key
            ),
            allocated as (
              select key, label, receipt_id, nextval(pg_get_serial_sequence('subjects', 'id')) as id from wanted
            ),
            labelled as (
              insert into subject_labels (namespace, key, subject_id, is_default, source)
              select ${namespace}, key, id, true, 'minted' from allocated
              on conflict do nothing
              returning key, subject_id
            ),
            created as (
              insert into subjects (id, label, origin_receipt_id)
              select a.id, left(a.label, 120), a.receipt_id from allocated a join labelled l on l.subject_id = a.id
              returning id
            ),
            matched as (
              insert into subject_matches (subject_id, comparison, origin_id)
              select id, comparison, id from created cross join (values (false), (true)) as w (comparison)
            )
            select key, subject_id::float8 as "subjectId" from labelled order by key`,
        );
        return {
          minted,
          invalidated:
            minted.length === 0
              ? 0
              : yield* invalidated("knowledge.mint", { keys: minted.map((row) => row.key), subjects: [] }),
        };
      }),
    );

  const labels = (keys: ReadonlyArray<LabelKey>) =>
    query(
      "knowledge.labels",
      decodeLabels,
      sql`
        select key, subject_id::float8 as "subjectId", is_default as "isDefault", source
        from knowledge_labels
        where namespace = ${namespace} and key = any(${sql.param([...keys])}::text[])
        order by key, subject_id`,
    );

  const project = <E, R>(
    repoIds: ReadonlyArray<RepoId>,
    compute: (repos: ReadonlyArray<LockedRepo>, revision: Revision) => Effect.Effect<ReadonlyArray<Projection>, E, R>,
  ) =>
    withTransaction(
      Effect.gen(function* () {
        yield* execute("knowledge.project", sharedLock);
        // Written, not just read, so two projections of one repo queue here instead of deadlocking on an upgrade, and
        // a facts update waits and then marks the row stale again.
        const locked = yield* query(
          "knowledge.project",
          decodeLocked,
          sql`
            select r.id::float8 as id, r.owner, r.name, c.id as "receiptId", r.language, r.license,
              r.topics, coalesce(c.claims, '[]') as claims
            from repos r left join receipts c on c.id = r.receipt_id
            where r.id = any(${sql.param([...repoIds])}::bigint[]) and r.gone_at is null
            order by r.id
            for no key update of r`,
        );
        const revision = yield* head;
        const projections = yield* compute(locked, revision);
        if (projections.length === 0) return { projected: 0, skipped: repoIds.length };
        const records = json(projections.map(projectionRecord));
        const written = yield* query(
          "knowledge.project",
          decodeIds,
          sql`
            with p as (
              select * from jsonb_to_recordset(${records}) as p (${projectionColumns})
            ),
            live as (
              select p.* from p join repos r on r.id = p.repo_id
              where r.receipt_id is not distinct from p.receipt_id and r.gone_at is null
            ),
            closed as (
              update repos r set ${assignments(closedColumns, "c")}
              from live c
              where r.id = c.repo_id and (${identifiers(closedColumns.map((column) => `r.${column}`))})
                is distinct from (${identifiers(closedColumns.map((column) => `c.${column}`))})
            ),
            facets as (
              update repo_facets f set
                receipt_id = c.receipt_id, revision = ${revision}, stale = false, projected_at = now(),
                ${assignments([...subjectColumns, "unresolved_keys"], "c")}
              from live c
              where f.repo_id = c.repo_id
              returning f.repo_id
            ),
            verdicts as (
              update receipts set projected_revision = ${revision}, verdicts = c.verdicts
              from live c
              where receipts.id = c.receipt_id
            )
            select repo_id::float8 as id from facets order by repo_id`,
        );
        return { projected: written.length, skipped: repoIds.length - written.length };
      }),
    );

  const decide = (decision: Decision) =>
    withTransaction(
      Effect.gen(function* () {
        yield* execute("knowledge.decide", exclusiveLock);
        const current = yield* head;
        if (current !== decision.expected) {
          return yield* new StaleRevision({ expected: decision.expected, head: current });
        }
        const { change } = decision;
        // A row that undo or redo puts back names an older revision. Only a new decision's labels can collide with a
        // mint, because a minted label sits in its own slot and an older decision row outranks it. A key minted for any
        // other subject is a merge to propose, even one this batch merges, or undoing that merge would leave the key
        // taken from its holder.
        const fresh = change.labelsAdded.filter((row) => row.revision > current);
        if (fresh.length > 0) {
          const [taken] = yield* query(
            "knowledge.decide",
            decodeTaken,
            sql`
              select l.key, a."subjectId"::float8 as "subjectId", l.subject_id::float8 as holder
              from jsonb_to_recordset(${json(fresh)}) as a (key text, "subjectId" bigint)
              join subject_labels l
                on l.namespace = ${namespace} and l.key = a.key and l.source = 'minted' and l.is_default
              where l.subject_id <> a."subjectId"
              order by l.key
              limit 1`,
          );
          if (taken !== undefined) return yield* new KeyMinted(taken);
        }
        const rows = decision.rows.map((row, index) => ({ ...row, revision: current + index + 1 }));
        yield* execute(
          "knowledge.decide",
          sql`
            insert into decisions (revision, kind, payload, undoes, actor, reason)
            select revision, kind, payload, undoes, actor, reason
            from jsonb_to_recordset(${json(rows)})
              as d (revision bigint, kind decision_kind, payload jsonb, undoes bigint, actor text, reason text)`,
        );
        const presented = sql`jsonb_to_recordset(${json(change.presented)})
          as s (id bigint, label text, definition text, status subject_status, "repoId" bigint)`;
        if (change.presented.length > 0) {
          // The unique index on repo_id is checked row by row, so a link that moves to another subject is released
          // before any subject takes it.
          yield* execute(
            "knowledge.decide",
            sql`
              update subjects set repo_id = null from ${presented}
              where subjects.id = s.id and subjects.repo_id is distinct from s."repoId"`,
          );
        }
        if (change.created.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subjects (id, label, definition, status, repo_id, origin_revision)
              select id, label, definition, status, "repoId", revision
              from jsonb_to_recordset(${json(change.created)}) as s (
                id bigint, label text, definition text, status subject_status, "repoId" bigint, revision bigint
              )`,
          );
        }
        if (change.presented.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              update subjects set label = coalesce(s.label, subjects.label), definition = s.definition,
                status = s.status, repo_id = s."repoId"
              from ${presented}
              where subjects.id = s.id`,
          );
        }
        if (change.labelsRemoved.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              delete from subject_labels l
              using jsonb_to_recordset(${json(change.labelsRemoved)}) as r (key text, "subjectId" bigint)
              where l.namespace = ${namespace} and l.key = r.key and l.subject_id = r."subjectId" and l.source = 'decision'`,
          );
        }
        if (change.labelsAdded.length > 0) {
          // A key projection already minted for the same subject resolves to it either way, so its row stays.
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
              select ${namespace}, key, "subjectId", "isDefault", 'decision', revision
              from jsonb_to_recordset(${json(change.labelsAdded)})
                as l (key text, "subjectId" bigint, "isDefault" boolean, revision bigint)
              on conflict (namespace, key, subject_id) do nothing`,
          );
        }
        if (change.unmerged.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`delete from subject_canonical where origin_id = any(${sql.param([...change.unmerged])}::bigint[])`,
          );
        }
        if (change.merged.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subject_canonical (namespace, origin_id, canonical_id, revision)
              select ${namespace}, "originId", "canonicalId", revision
              from jsonb_to_recordset(${json(change.merged)}) as m ("originId" bigint, "canonicalId" bigint, revision bigint)
              on conflict (origin_id) do update set canonical_id = excluded.canonical_id, revision = excluded.revision`,
          );
        }
        if (change.edgesRemoved.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              delete from subject_closure c
              using jsonb_to_recordset(${json(change.edgesRemoved)}) as e ("ancestorId" bigint, "descendantId" bigint)
              where c.ancestor_id = e."ancestorId" and c.descendant_id = e."descendantId"`,
          );
        }
        if (change.edgesAdded.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subject_closure (namespace, ancestor_id, descendant_id, depth, via, revision)
              select ${namespace}, "ancestorId", "descendantId", depth, via, revision
              from jsonb_to_recordset(${json(change.edgesAdded)})
                as e ("ancestorId" bigint, "descendantId" bigint, depth smallint, via closure_via, revision bigint)`,
          );
        }
        if (change.refresh.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`select knowledge_refresh_matches(${sql.param([...change.refresh])}::bigint[])`,
          );
        }
        const outranked =
          change.labelsAdded.length === 0
            ? []
            : yield* query(
                "knowledge.decide",
                decodeSubjectIds,
                sql`
                  select distinct l.subject_id::float8 as id
                  from jsonb_to_recordset(${json(change.labelsAdded)}) as a (key text, "subjectId" bigint)
                  join subject_labels l
                    on l.namespace = ${namespace} and l.key = a.key and l.source = 'minted' and l.is_default
                  where l.subject_id <> a."subjectId"`,
              );
        const { keys, subjects, repos: corrected } = change.invalidate;
        const marked =
          keys.length + subjects.length + outranked.length === 0
            ? 0
            : yield* invalidated("knowledge.decide", {
                keys,
                subjects: [...subjects, ...outranked.map((row) => row.id)],
              });
        const repos =
          corrected.length === 0
            ? []
            : yield* query(
                "knowledge.decide",
                decodeIds,
                sql`
                  update repo_facets set stale = true
                  where not stale and repo_id = any(${sql.param([...corrected])}::bigint[])
                  returning repo_id::float8 as id`,
              );
        return { revision: Revision.make(current + rows.length), invalidated: marked + repos.length };
      }),
    );

  const keepLegacy = <E, R>(
    page: { readonly after: number; readonly limit: number },
    build: (repos: ReadonlyArray<LegacyRepo>) => Effect.Effect<ReadonlyArray<LegacyAnswer>, E, R>,
  ) =>
    withTransaction(
      Effect.gen(function* () {
        // Shared, so no mint's invalidation marks repo_facets rows while this page's receipt trigger marks them too.
        yield* execute("knowledge.keepLegacy", sharedLock);
        const read = yield* query(
          "knowledge.keepLegacy",
          decodeLegacy,
          sql`
            select r.id::float8 as id, r.owner, r.name, r.description, r.topics, r.language,
              r.summary_readme_oid as "summaryReadmeOid", r.summary_recipe as "summaryRecipe", r.summary, r.keywords,
              r.kind,
              case when c.id is not null then
                jsonb_build_object('recipe', c.recipe, 'summary', c.summary, 'keywords', c.keywords)
              end as current
            from repos r left join receipts c on c.id = r.receipt_id
            where r.id > ${page.after} and r.summary is not null and r.gone_at is null
              and (r.receipt_id is null or c.source = 'legacy')
            order by r.id
            limit ${page.limit}
            for no key update of r`,
        );
        const last = read.at(-1)?.id ?? null;
        const answers = yield* build(read);
        if (answers.length === 0) return { read: read.length, last, inserted: 0, pointed: 0 };
        const [kept] = yield* query(
          "knowledge.keepLegacy",
          decodeKept,
          sql`
            with answer as (
              select * from jsonb_to_recordset(${json(answers)}) as a (
                "repoId" bigint, "inputHash" text, recipe integer, summary text, keywords jsonb, claims jsonb,
                lanes jsonb, dropped jsonb
              )
            ),
            inserted as (
              insert into receipts (id, repo_id, source, input_hash, recipe, model, summary, keywords, claims, lanes,
                dropped)
              select gen_random_uuid(), "repoId", 'legacy', "inputHash", recipe, 'legacy', summary, keywords, claims,
                lanes, dropped
              from answer
              on conflict (repo_id, source, input_hash, recipe) do nothing
              returning id, repo_id
            ),
            kept as (
              select repo_id, id from inserted
              union all
              select r.repo_id, r.id from answer a join receipts r
                on (r.repo_id, r.source, r.input_hash, r.recipe) = (a."repoId", 'legacy', a."inputHash", a.recipe)
            ),
            pointed as (
              update repos set receipt_id = k.id from kept k
              where repos.id = k.repo_id and repos.receipt_id is distinct from k.id
              returning repos.id
            )
            select (select count(*) from inserted)::integer as inserted,
              (select count(*) from pointed)::integer as pointed`,
        );
        return { read: read.length, last, inserted: kept?.inserted ?? 0, pointed: kept?.pointed ?? 0 };
      }),
    );

  const log = (operation: Operation, filter: SQL) =>
    query(
      operation,
      decodeDecisions,
      sql`
        select revision::float8 as revision, payload - 'created' - 'base' as decision,
          (payload ->> 'created')::float8 as created, payload ->> 'base' as base
        from decisions where namespace = ${namespace} ${filter} order by revision`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(({ base, ...row }): Decisions.StoredDecision => (base === null ? row : { ...row, base })),
      ),
    );

  return {
    capture: (answers) => (answers.length === 0 ? Effect.succeed([]) : capture(answers)),
    mint: (claims) => (claims.length === 0 ? Effect.succeed({ minted: [], invalidated: 0 }) : mint(claims)),
    labels,
    project,
    stale: (limit) =>
      query(
        "knowledge.stale",
        decodeIds,
        sql`select repo_id::float8 as id from repo_facets where stale order by repo_id limit ${limit}`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    invalidate: (invalidation) =>
      withTransaction(
        execute("knowledge.invalidate", exclusiveLock).pipe(
          Effect.andThen(invalidated("knowledge.invalidate", invalidation)),
        ),
      ),
    count: query("knowledge.count", decodeCount, sql`select knowledge_refresh_counts() as count`).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    ),
    countAtoms: query("knowledge.countAtoms", decodeCount, sql`select knowledge_refresh_atom_stats() as count`).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    ),
    allocate: (count) =>
      query(
        "knowledge.allocate",
        decodeSubjectIds,
        sql`select nextval(pg_get_serial_sequence('subjects', 'id'))::float8 as id from generate_series(1, ${count})`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    revision: head,
    decisions: log("knowledge.decisions", sql``),
    rules: log("knowledge.rules", sql`and kind in ('merge', 'split', 'correct', 'undo')`),
    decide,
    subjects: (ids) =>
      query(
        "knowledge.subjects",
        decodeSubjects,
        sql`
          select s.id::float8 as id, s.label, s.definition, s.status, s.repo_count as "repoCount",
            coalesce(c.canonical_id, s.id)::float8 as "canonicalId"
          from subjects s left join subject_canonical c on c.origin_id = s.id
          where s.id = any(${sql.param([...ids])}::bigint[]) and s.namespace = ${namespace}
          order by s.id`,
      ),
    minted: (keys) =>
      query(
        "knowledge.minted",
        decodeKeyHolders,
        sql`
          select key, subject_id::float8 as "subjectId" from subject_labels
          where namespace = ${namespace} and source = 'minted' and is_default
            and key = any(${sql.param([...keys])}::text[])
          order by key`,
      ),
    reach: (impacts) =>
      impacts.length === 0
        ? Effect.succeed([])
        : query(
            "knowledge.reach",
            decodeReach,
            sql`
              select (
                select count(*) from repo_facets f
                where f.unresolved_keys && i.keys
                  or f.members && i.subjects or f.built_with && i.subjects
                  or f.alternative_to && i.subjects or f.replaced_by && i.subjects
                  or f.repo_id = any(i.repos)
              )::integer as repos
              from jsonb_to_recordset(${json(impacts.map((impact, n) => ({ n, ...impact })))})
                as i (n integer, keys text[], subjects bigint[], repos bigint[])
              order by i.n`,
          ).pipe(Effect.map((rows) => rows.map((row) => row.repos))),
    // Each subject's origins are resolved once, so every lookup below is one GIN probe of one array.
    examples: (ids, limit) =>
      query(
        "knowledge.examples",
        decodeExamples,
        sql`
          with t as (
            select u.id, knowledge_origins(array[u.id], true) as widened,
              knowledge_origins(array[u.id], false) as compared
            from unnest(${sql.param([...ids])}::bigint[]) as u (id)
          )
          select t.id::float8 as "subjectId", array(
            select x.repo_id::float8 from (
              (select f.repo_id from repo_facets f where f.members && t.widened order by f.repo_id limit ${limit})
              union
              (select f.repo_id from repo_facets f where f.built_with && t.widened order by f.repo_id limit ${limit})
              union
              (select f.repo_id from repo_facets f where f.alternative_to && t.compared order by f.repo_id limit ${limit})
            ) x
            order by x.repo_id limit ${limit}
          ) as repos
          from t`,
      ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.subjectId, row.repos])))),
    floor: query(
      "knowledge.floor",
      decodeSubjectIds,
      sql`
        select s.id::float8 as id
        from subjects s
        cross join lateral (
          select count(distinct r.owner) as owners
          from repo_facets f join repos r on r.id = f.repo_id
          where f.members && knowledge_origins(array[s.id], true)
            or f.built_with && knowledge_origins(array[s.id], true)
            or f.alternative_to && knowledge_origins(array[s.id], false)
            or f.replaced_by && knowledge_origins(array[s.id], false)
        ) o
        where s.namespace = ${namespace} and s.status = 'candidate' and s.repo_count >= 3 and o.owners >= 2
          and not exists (select 1 from subject_canonical c where c.origin_id = s.id)
        order by s.id`,
    ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    variants: query(
      "knowledge.variants",
      decodeVariants,
      sql`
        with resolved as (
          select l.key, coalesce(c.canonical_id, l.subject_id) as subject_id,
            replace(replace(l.key, ' ', ''), '.', '') as squashed
          from knowledge_labels l
          left join subject_canonical c on c.origin_id = l.subject_id
          join subjects s on s.id = coalesce(c.canonical_id, l.subject_id) and s.status <> 'rejected'
          where l.namespace = ${namespace} and l.is_default and length(l.key) > 3
        ),
        pairs as (
          select 'separator' as channel, a.*, b.key as b_key, b.subject_id as b_subject
          from resolved a join resolved b on b.squashed = a.squashed and a.key < b.key
          union all
          select 'plural', a.*, b.key, b.subject_id
          from resolved a join resolved b on b.key = a.key || 's'
          union all
          select 'js', a.*, b.key, b.subject_id
          from resolved a join resolved b on b.squashed = a.squashed || 'js'
        )
        select distinct channel,
          jsonb_build_object('key', key, 'subjectId', subject_id) as a,
          jsonb_build_object('key', b_key, 'subjectId', b_subject) as b
        from pairs where subject_id <> b_subject
        order by 1, 2, 3`,
    ),
    keepLegacy,
  } satisfies Queries;
});
