import { RepoId } from "@stargrep/github/schemas";
import type { FacetRef } from "@stargrep/knowledge/atom";
import { Claim } from "@stargrep/knowledge/claims";
import { ReceiptId, type Revision, SubjectId } from "@stargrep/knowledge/ids";
import { LabelKey } from "@stargrep/knowledge/label-key";
import type { ClaimVerdict } from "@stargrep/knowledge/projection";
import type { Dim, RoleId } from "@stargrep/knowledge/registry";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../../errors.ts";
import * as Postgres from "../../postgres.ts";
import { json, rowsDecoder, statements } from "../../rows.ts";
import { atomColumns } from "../../schema.ts";
import { exclusiveLock, namespace, sharedLock, vocabulary } from "./lock.ts";

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

export interface Queries {
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
  readonly stale: (limit: number) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
}

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
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);
  const { head, invalidated } = vocabulary(query);

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

  return {
    mint: (claims) => (claims.length === 0 ? Effect.succeed({ minted: [], invalidated: 0 }) : mint(claims)),
    labels,
    project,
    stale: (limit) =>
      query(
        "knowledge.stale",
        decodeIds,
        sql`select repo_id::float8 as id from repo_facets where stale order by repo_id limit ${limit}`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
  } satisfies Queries;
});
