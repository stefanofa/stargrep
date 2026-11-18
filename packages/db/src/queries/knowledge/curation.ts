import { RepoId } from "@stargrep/github/schemas";
import type { Change } from "@stargrep/knowledge/curation";
import * as Decisions from "@stargrep/knowledge/decisions";
import { Revision, SubjectId } from "@stargrep/knowledge/ids";
import { LabelKey } from "@stargrep/knowledge/label-key";
import { type SQL, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type DbQueryFailed, type DbRowInvalid, KeyMinted, type Operation, StaleRevision } from "../../errors.ts";
import * as Postgres from "../../postgres.ts";
import { json, rowsDecoder, statements } from "../../rows.ts";
import type { decisionKind, subjectStatus } from "../../schema.ts";
import { exclusiveLock, namespace, vocabulary } from "./lock.ts";

export type DecisionKind = (typeof decisionKind.enumValues)[number];
export type SubjectStatus = (typeof subjectStatus.enumValues)[number];

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
  // The derived rows the run changes, as the fold computes them against the log at the expected revision. Every
  // revision is explicit: a new row names the decision that owns it, which an undo may name instead of itself. Only
  // decision rows change. Projection's minted labels stay.
  readonly change: Change;
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

// One page of the usage floor: the candidates it accepts, and the last candidate it read when more may follow.
export interface FloorPage {
  readonly accepted: ReadonlyArray<SubjectId>;
  readonly last: SubjectId | null;
}

export interface Queries {
  // The public curation log in revision order.
  readonly decisions: Effect.Effect<ReadonlyArray<Decisions.StoredDecision>, DbQueryFailed | DbRowInvalid>;
  // The rows projection replays for its rules: merges, splits, corrections, and undos.
  readonly rules: Effect.Effect<ReadonlyArray<Decisions.StoredDecision>, DbQueryFailed | DbRowInvalid>;
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
  // repos have at least two owners. It reads at most limit candidates after the given ID, in ID order, and returns the
  // last one it read when it read limit of them, so the caller pages through every candidate.
  readonly floor: (page: {
    readonly after: SubjectId | null;
    readonly limit: number;
  }) => Effect.Effect<FloorPage, DbQueryFailed | DbRowInvalid>;
  // Label pairs whose keys differ by a separator, a plural s, or a js suffix, resolved to two different live subjects,
  // keys of three characters or fewer left out.
  readonly variants: Effect.Effect<ReadonlyArray<Variant>, DbQueryFailed | DbRowInvalid>;
}

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
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeSubjectIds = rowsDecoder(Schema.Struct({ id: SubjectId }));
const decodeFloor = rowsDecoder(Schema.Struct({ id: SubjectId, accepted: Schema.Boolean }));

export const make = Effect.gen(function* () {
  const { run, withTransaction, withLongTimeout } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);
  const { head, invalidated } = vocabulary(query);

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
        const steps: ReadonlyArray<readonly [ReadonlyArray<unknown>, SQL]> = [
          // The unique index on repo_id is checked row by row, so a link that moves to another subject is released
          // before any subject takes it.
          [
            change.presented,
            sql`
              update subjects set repo_id = null from ${presented}
              where subjects.id = s.id and subjects.repo_id is distinct from s."repoId"`,
          ],
          [
            change.created,
            sql`
              insert into subjects (id, label, definition, status, repo_id, origin_revision)
              select id, label, definition, status, "repoId", revision
              from jsonb_to_recordset(${json(change.created)}) as s (
                id bigint, label text, definition text, status subject_status, "repoId" bigint, revision bigint
              )`,
          ],
          [
            change.presented,
            sql`
              update subjects set label = coalesce(s.label, subjects.label), definition = s.definition,
                status = s.status, repo_id = s."repoId"
              from ${presented}
              where subjects.id = s.id`,
          ],
          [
            change.labelsRemoved,
            sql`
              delete from subject_labels l
              using jsonb_to_recordset(${json(change.labelsRemoved)}) as r (key text, "subjectId" bigint)
              where l.namespace = ${namespace} and l.key = r.key and l.subject_id = r."subjectId" and l.source = 'decision'`,
          ],
          // A key projection already minted for the same subject resolves to it either way, so its row stays.
          [
            change.labelsAdded,
            sql`
              insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
              select ${namespace}, key, "subjectId", "isDefault", 'decision', revision
              from jsonb_to_recordset(${json(change.labelsAdded)})
                as l (key text, "subjectId" bigint, "isDefault" boolean, revision bigint)
              on conflict (namespace, key, subject_id) do nothing`,
          ],
          [
            change.unmerged,
            sql`delete from subject_canonical where origin_id = any(${sql.param([...change.unmerged])}::bigint[])`,
          ],
          [
            change.merged,
            sql`
              insert into subject_canonical (namespace, origin_id, canonical_id, revision)
              select ${namespace}, "originId", "canonicalId", revision
              from jsonb_to_recordset(${json(change.merged)}) as m ("originId" bigint, "canonicalId" bigint, revision bigint)
              on conflict (origin_id) do update set canonical_id = excluded.canonical_id, revision = excluded.revision`,
          ],
          [
            change.edgesRemoved,
            sql`
              delete from subject_closure c
              using jsonb_to_recordset(${json(change.edgesRemoved)}) as e ("ancestorId" bigint, "descendantId" bigint)
              where c.ancestor_id = e."ancestorId" and c.descendant_id = e."descendantId"`,
          ],
          [
            change.edgesAdded,
            sql`
              insert into subject_closure (namespace, ancestor_id, descendant_id, depth, via, revision)
              select ${namespace}, "ancestorId", "descendantId", depth, via, revision
              from jsonb_to_recordset(${json(change.edgesAdded)})
                as e ("ancestorId" bigint, "descendantId" bigint, depth smallint, via closure_via, revision bigint)`,
          ],
          [change.refresh, sql`select knowledge_refresh_matches(${sql.param([...change.refresh])}::bigint[])`],
        ];
        yield* Effect.forEach(
          steps,
          ([rows, statement]) => (rows.length === 0 ? Effect.void : execute("knowledge.decide", statement)),
          { discard: true },
        );
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
    // Two owners need only one holder whose owner differs from the first's, so it stops reading repos there instead of
    // counting the owners of every holder. It still finds every candidate's holders, so a page runs under the long
    // limit.
    floor: ({ after, limit }) =>
      withLongTimeout(
        query(
          "knowledge.floor",
          decodeFloor,
          sql`
          with page as (
            select s.id from subjects s
            where s.namespace = ${namespace} and s.status = 'candidate' and s.repo_count >= 3
              and s.id > ${after ?? 0}
              and not exists (select 1 from subject_canonical c where c.origin_id = s.id)
            order by s.id
            limit ${limit}
          )
          select p.id::float8 as id, exists (
            select 1 from repos r
            where r.id = any(holders.ids)
              and r.owner <> (select first.owner from repos first where first.id = holders.ids[1])
          ) as accepted
          from page p
          cross join lateral (
            select array_agg(f.repo_id) as ids
            from repo_facets f
            where f.members && knowledge_origins(array[p.id], true)
              or f.built_with && knowledge_origins(array[p.id], true)
              or f.alternative_to && knowledge_origins(array[p.id], false)
              or f.replaced_by && knowledge_origins(array[p.id], false)
          ) holders
          order by p.id`,
        ),
      ).pipe(
        Effect.map(
          (rows): FloorPage => ({
            accepted: rows.flatMap((row) => (row.accepted ? [row.id] : [])),
            last: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
          }),
        ),
      ),
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
  } satisfies Queries;
});
