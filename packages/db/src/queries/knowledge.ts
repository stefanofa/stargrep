import { type ObjectId, RepoId } from "@stargrep/github/schemas";
import type { FacetRef } from "@stargrep/knowledge/atom";
import { type BatchId, type InputHash, ReceiptId, Revision, SubjectId } from "@stargrep/knowledge/ids";
import { LabelKey } from "@stargrep/knowledge/label-key";
import type { Dim, RoleId } from "@stargrep/knowledge/registry";
import { type SQL, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type DbQueryFailed, type DbRowInvalid, type Operation, StaleRevision } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { resultRows, rowsDecoder } from "../rows.ts";
import {
  atomColumns,
  type closureVia,
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
export type ClosureVia = (typeof closureVia.enumValues)[number];

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
  readonly claims: ReadonlyArray<Schema.Json>;
  readonly lanes: { readonly [role: string]: "complete" | "invalid" | "missing" };
  readonly dropped: ReadonlyArray<Schema.Json>;
  readonly carriedFrom: ReceiptId | null;
  readonly rawKey: string | null;
}

// receiptId is the answer the repo points at: the one captured, or the receipt an earlier capture of the same source,
// input, and recipe already committed. saved is false when the repo's README or inputs moved on, or it is gone.
export interface Captured {
  readonly repoId: RepoId;
  readonly receiptId: ReceiptId;
  readonly saved: boolean;
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

// A repo as projection reads it, locked until the projection commits: its GitHub facts and its receipt's claims.
export interface LockedRepo {
  readonly id: RepoId;
  readonly receiptId: ReceiptId | null;
  readonly language: string | null;
  readonly license: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly claims: ReadonlyArray<Schema.Json>;
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
  readonly verdicts: ReadonlyArray<Schema.Json>;
}

export interface Projected {
  readonly projected: number;
  readonly skipped: number;
}

export interface Invalidation {
  readonly keys: ReadonlyArray<LabelKey>;
  readonly subjects: ReadonlyArray<SubjectId>;
}

// The derived state one decision changes, as the fold computes it against the log at the expected revision. Every
// revision is explicit: a new row names the decision that owns it, which an undo may name instead of itself.
export interface VocabularyChange {
  readonly created: ReadonlyArray<{
    readonly id: SubjectId;
    readonly label: string;
    readonly definition: string | null;
    readonly status: SubjectStatus;
  }>;
  readonly presented: ReadonlyArray<{
    readonly id: SubjectId;
    readonly label: string;
    readonly definition: string | null;
    readonly status: SubjectStatus;
    readonly repoId: RepoId | null;
  }>;
  readonly labelsAdded: ReadonlyArray<{
    readonly key: LabelKey;
    readonly subjectId: SubjectId;
    readonly isDefault: boolean;
    readonly revision: Revision;
  }>;
  // Only decision rows. Projection's minted labels stay.
  readonly labelsRemoved: ReadonlyArray<{ readonly key: LabelKey; readonly subjectId: SubjectId }>;
  readonly merged: ReadonlyArray<{
    readonly originId: SubjectId;
    readonly canonicalId: SubjectId;
    readonly revision: Revision;
  }>;
  readonly unmerged: ReadonlyArray<SubjectId>;
  readonly edgesAdded: ReadonlyArray<{
    readonly ancestorId: SubjectId;
    readonly descendantId: SubjectId;
    readonly depth: 1 | 2 | 3;
    readonly via: ClosureVia;
    readonly revision: Revision;
  }>;
  readonly edgesRemoved: ReadonlyArray<{ readonly ancestorId: SubjectId; readonly descendantId: SubjectId }>;
  readonly invalidate: Invalidation;
}

export const noChange: VocabularyChange = {
  created: [],
  presented: [],
  labelsAdded: [],
  labelsRemoved: [],
  merged: [],
  unmerged: [],
  edgesAdded: [],
  edgesRemoved: [],
  invalidate: { keys: [], subjects: [] },
};

export interface Decision {
  // The head revision the caller computed the change against.
  readonly expected: Revision;
  readonly kind: DecisionKind;
  readonly payload: { readonly _tag: string; readonly [field: string]: Schema.Json };
  readonly undoes: Revision | null;
  readonly actor: string;
  readonly reason: string;
  readonly change: VocabularyChange;
}

export interface Decided {
  readonly revision: Revision;
  readonly invalidated: number;
}

// The only writer of the knowledge tables. Capture saves answers, mint and decide change the vocabulary, and project
// writes the atoms, each under the lock protocol above.
export interface Queries {
  // Commit A: receipts, then the summary of every repo whose README and inputs still match and that is not gone. Every
  // repo's enrichment lease is cleared, saved or not. The trigger on receipt_id marks the repo stale.
  readonly capture: (
    answers: ReadonlyArray<Answer>,
  ) => Effect.Effect<ReadonlyArray<Captured>, DbQueryFailed | DbRowInvalid>;
  // Commit B, step 1: a subject, its minted default label, and its own two subject_matches rows for every key no label
  // has yet, then marks stale the repos that looked one of those keys up and found nothing.
  readonly mint: (claims: ReadonlyArray<MintClaim>) => Effect.Effect<Minted, DbQueryFailed | DbRowInvalid>;
  // The labels resolution reads, from knowledge_labels.
  readonly labels: (keys: ReadonlyArray<LabelKey>) => Effect.Effect<ReadonlyArray<Label>, DbQueryFailed | DbRowInvalid>;
  // Commit B, step 2: under the shared lock, locks the live repos for no key update in ID order, hands them to
  // compute, and writes each projection's closed arrays, facets row, and verdicts where the repo still points at the
  // receipt projected.
  readonly project: <E, R>(
    repoIds: ReadonlyArray<RepoId>,
    compute: (repos: ReadonlyArray<LockedRepo>) => Effect.Effect<ReadonlyArray<Projection>, E, R>,
  ) => Effect.Effect<Projected, E | DbQueryFailed | DbRowInvalid, R>;
  readonly stale: (limit: number) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly invalidate: (invalidation: Invalidation) => Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // The nightly count behind listing. Returns how many subjects changed.
  readonly count: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // Fresh subject IDs for a decision that creates subjects, so its payload can name them.
  readonly allocate: (count: number) => Effect.Effect<ReadonlyArray<SubjectId>, DbQueryFailed | DbRowInvalid>;
  readonly revision: Effect.Effect<Revision, DbQueryFailed | DbRowInvalid>;
  // Appends the decision at the next revision, applies its change, rebuilds subject_matches, and marks stale the repos
  // its invalidation names. Fails with StaleRevision when the log moved past the expected revision.
  readonly decide: (decision: Decision) => Effect.Effect<Decided, StaleRevision | DbQueryFailed | DbRowInvalid>;
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

const decodeCaptured = rowsDecoder(Schema.Struct({ repoId: RepoId, receiptId: ReceiptId, saved: Schema.Boolean }));
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
    receiptId: Schema.NullOr(ReceiptId),
    language: Schema.NullOr(Schema.String),
    license: Schema.NullOr(Schema.String),
    topics: Schema.Array(Schema.String),
    claims: Schema.Array(Schema.Json),
  }),
);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeSubjectIds = rowsDecoder(Schema.Struct({ id: SubjectId }));
const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const decodeRevision = rowsDecoder(Schema.Struct({ revision: Revision }));

const only = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => Effect.orDie(Effect.fromNullishOr(rows[0]));

const keepsEmbedding = sql`not ${unreadEnrichment(repos)}`;

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
              select * from jsonb_to_recordset(${json(answers)}) as a (
                "receiptId" uuid, "repoId" bigint, source receipt_source, "inputHash" text, "readmeOid" text,
                recipe integer, model text, "batchId" uuid, summary text, keywords jsonb, claims jsonb, lanes jsonb,
                dropped jsonb, "carriedFrom" uuid, "rawKey" text
              )
            ),
            inserted as (
              insert into receipts (id, repo_id, source, input_hash, recipe, model, batch_id, summary, keywords, claims,
                lanes, dropped, carried_from, raw_key)
              select "receiptId", "repoId", source, "inputHash", recipe, model, "batchId", summary, keywords, claims, lanes,
                dropped, "carriedFrom", "rawKey"
              from answer
              on conflict (repo_id, source, input_hash, recipe) do nothing
              returning id, repo_id
            ),
            -- A retried answer converges on the receipt committed first, text included, so the repo always shows the
            -- answer its receipt holds.
            winner as (
              select a."repoId", a."readmeOid", a."inputHash", a.recipe, i.id as receipt_id, a.summary, a.keywords
              from answer a join inserted i on i.id = a."receiptId"
              union all
              select a."repoId", a."readmeOid", a."inputHash", a.recipe, r.id, r.summary, r.keywords
              from answer a join receipts r
                on (r.repo_id, r.source, r.input_hash, r.recipe) = (a."repoId", a.source, a."inputHash", a.recipe)
            ),
            -- A new summary of the README a read repo's summary describes keeps the old embedding, marked stale, as
            -- saveSummary does.
            saved as (
              update repos set
                summary = w.summary,
                keywords = w.keywords,
                summary_readme_oid = w."readmeOid",
                summary_recipe = w.recipe,
                summary_input_hash = w."inputHash",
                receipt_id = w.receipt_id,
                enrich_retry_at = null,
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
              where repos.id = w."repoId" and not exists (select 1 from saved s where s.id = w."repoId")
            )
            select w."repoId"::float8 as "repoId", w.receipt_id as "receiptId",
              exists (select 1 from saved s where s.id = w."repoId") as saved
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
    compute: (repos: ReadonlyArray<LockedRepo>) => Effect.Effect<ReadonlyArray<Projection>, E, R>,
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
            select r.id::float8 as id, r.receipt_id as "receiptId", r.language, r.license, r.topics,
              coalesce(c.claims, '[]') as claims
            from repos r left join receipts c on c.id = r.receipt_id
            where r.id = any(${sql.param([...repoIds])}::bigint[]) and r.gone_at is null
            order by r.id
            for no key update of r`,
        );
        const revision = yield* head;
        const projections = yield* compute(locked);
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
        const revision = Revision.make(current + 1);
        const { change } = decision;
        yield* execute(
          "knowledge.decide",
          sql`
            insert into decisions (revision, kind, payload, undoes, actor, reason)
            values (${revision}, ${decision.kind}, ${json(decision.payload)}, ${decision.undoes}, ${decision.actor}, ${decision.reason})`,
        );
        if (change.created.length > 0) {
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subjects (id, label, definition, status, origin_revision)
              select id, label, definition, status, ${revision}
              from jsonb_to_recordset(${json(change.created)}) as s (id bigint, label text, definition text, status subject_status)`,
          );
        }
        if (change.presented.length > 0) {
          const presented = sql`jsonb_to_recordset(${json(change.presented)})
            as s (id bigint, label text, definition text, status subject_status, "repoId" bigint)`;
          // The unique index on repo_id is checked row by row, so a link that moves to another subject is released
          // before any subject takes it.
          yield* execute(
            "knowledge.decide",
            sql`
              update subjects set repo_id = null from ${presented}
              where subjects.id = s.id and subjects.repo_id is distinct from s."repoId"`,
          );
          yield* execute(
            "knowledge.decide",
            sql`
              update subjects set label = s.label, definition = s.definition, status = s.status, repo_id = s."repoId"
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
          yield* execute(
            "knowledge.decide",
            sql`
              insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
              select ${namespace}, key, "subjectId", "isDefault", 'decision', revision
              from jsonb_to_recordset(${json(change.labelsAdded)})
                as l (key text, "subjectId" bigint, "isDefault" boolean, revision bigint)`,
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
        // A full rebuild until curation restricts it to the subjects a decision touches and their ancestors.
        yield* execute("knowledge.decide", sql`select knowledge_rebuild_matches()`);
        return { revision, invalidated: yield* invalidated("knowledge.decide", change.invalidate) };
      }),
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
    allocate: (count) =>
      query(
        "knowledge.allocate",
        decodeSubjectIds,
        sql`select nextval(pg_get_serial_sequence('subjects', 'id'))::float8 as id from generate_series(1, ${count})`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
    revision: head,
    decide,
  } satisfies Queries;
});
