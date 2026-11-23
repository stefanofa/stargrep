import { RepoId } from "@stargrep/github/schemas";
import { formatAtom } from "@stargrep/knowledge/atom";
import { labelKey } from "@stargrep/knowledge/label-key";
import {
  type ClosedDim,
  closed,
  closedKeys,
  closedLabel,
  Dim,
  dimPrefix,
  hiddenRoles,
  roleIds,
  roles,
} from "@stargrep/knowledge/registry";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, statements } from "../rows.ts";

// Reads of the atoms repos hold and match, for cards, the repo panel, library chips, and lookups. Every read goes
// through the views, so a merge, a split, a rejection, or the self rule shows here as it does in search. No read returns
// an atom of a role the registry hides.

// One atom a repo holds, as a card or the panel shows it.
export interface HeldAtom {
  // The atom's shortest key, which also works as a filter: "kind:library", "written-in:lang:rust", "about:subject:4127".
  readonly atom: string;
  readonly label: string;
  // False for a subject fewer than two repos hold. True for every closed value.
  readonly listed: boolean;
  // The repo a Link decision ties the subject to.
  readonly repoId: RepoId | null;
}

// The keys library chips count, per repo, and a label for each. A key is bare, such as "lang:rust" or "subject:812",
// built_with's own "with:" key, or a comparison's, such as "alt:subject:77", and a subject key shows only once the
// subject is listed. So a chip's count equals what its filter returns, and no chip shows a concept one repo names.
export interface MatchingAtoms {
  readonly atoms: ReadonlyMap<RepoId, ReadonlyArray<string>>;
  readonly labels: Readonly<Record<string, string>>;
}

export interface FacetCount {
  // A bare key, such as "subject:812" or "license:PostgreSQL".
  readonly atom: string;
  readonly label: string;
  // Live repos its filter matches, from the last nightly count.
  readonly repos: number;
}

export interface Queries {
  readonly held: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyMap<RepoId, ReadonlyArray<HeldAtom>>, DbQueryFailed | DbRowInvalid>;
  readonly matching: (ids: ReadonlyArray<RepoId>) => Effect.Effect<MatchingAtoms, DbQueryFailed | DbRowInvalid>;
  // Closed values and listed public subjects with a label key that starts with the query's, most-held first.
  readonly lookup: (input: {
    readonly q: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<FacetCount>, DbQueryFailed | DbRowInvalid>;
}

const namespace = "public";

const HeldRow = Schema.Struct({
  repoId: RepoId,
  atom: Schema.String,
  dim: Dim,
  value: Schema.String,
  subjectLabel: Schema.NullOr(Schema.String),
  listed: Schema.Boolean,
  linked: Schema.NullOr(RepoId),
});

const MatchingRow = Schema.Struct({
  atoms: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  subjects: Schema.Record(Schema.String, Schema.String),
});

const SubjectCount = Schema.Struct({ id: Schema.Finite, label: Schema.String, repos: Schema.Int });
const LookupRow = Schema.Struct({
  subjects: Schema.Array(SubjectCount),
  closed: Schema.Record(Schema.String, Schema.Int),
});

const decodeHeld = rowsDecoder(HeldRow);
const decodeMatching = rowsDecoder(MatchingRow);
const decodeStored = rowsDecoder(Schema.Struct({ ...MatchingRow.fields, missing: Schema.Array(RepoId) }));
const decodeLookup = rowsDecoder(LookupRow);

const prefixDims = new Map(Dim.literals.map((dim) => [dimPrefix[dim], dim]));

// The label of a key the views emit: its last two parts are the dimension's prefix and the value's ID.
const labelOf = (atom: string, subjects: Readonly<Record<string, string>>) => {
  const [prefix = "", id = ""] = atom.split(":").slice(-2);
  const dim = prefixDims.get(prefix);
  return dim === undefined ? atom : dim === "subject" ? (subjects[id] ?? atom) : closedLabel(dim, id);
};

const hiddenWires = hiddenRoles.map((id) => roles[id].wire);

const likePrefix = (key: string) => `${key.replace(/[\\%_]/g, "\\$&")}%`;

const closedDims = Dim.literals.filter((dim): dim is ClosedDim => dim !== "subject");

const closedMatches = (prefix: string) =>
  closedDims.flatMap((dim) =>
    closed[dim]
      .filter((value) => closedKeys(value).some((key) => key.startsWith(prefix)))
      .map((value) => ({ dim, id: value.id, label: value.label })),
  );

export const make = Effect.gen(function* () {
  const { query } = statements((yield* Postgres.Postgres).run);

  // Kinds keep the order projection gave them, so the primary kind comes first. Every other closed array is sorted.
  const held = (ids: ReadonlyArray<RepoId>) =>
    query(
      "facets.held",
      decodeHeld,
      sql`
        select e.repo_id::float8 as "repoId",
          coalesce(knowledge_role_key(e.role, e.dim, e.value), knowledge_atom_key(e.role, e.dim, e.value)) as atom,
          e.dim, e.value, s.label as "subjectLabel", coalesce(s.listed, true) as listed, s.repo_id::float8 as linked
        from effective_atoms e
        join repos r on r.id = e.repo_id
        left join subjects s on s.id = case when e.dim = 'subject' then e.value::bigint end
        where e.repo_id = any(${sql.param([...ids])}::bigint[])
          and e.role <> all(${sql.param([...hiddenRoles])}::text[])
        order by e.repo_id, array_position(${sql.param([...roleIds])}::text[], e.role),
          array_position(${sql.param([...Dim.literals])}::text[], e.dim),
          array_position(r.kinds::text[], e.value) nulls last, s.label nulls first, e.value`,
    ).pipe(
      Effect.map((rows) => {
        const byRepo = new Map<RepoId, Array<HeldAtom>>();
        for (const row of rows) {
          const atoms = byRepo.get(row.repoId) ?? [];
          atoms.push({
            atom: row.atom,
            label: row.dim === "subject" ? (row.subjectLabel ?? row.value) : closedLabel(row.dim, row.value),
            listed: row.listed,
            repoId: row.linked,
          });
          byRepo.set(row.repoId, atoms);
        }
        return byRepo as ReadonlyMap<RepoId, ReadonlyArray<HeldAtom>>;
      }),
    );

  // A repo's keys come from its repo_matching_keys row, and a subject key shows only while its subject is listed. The
  // subjects are read as one array, which Postgres sorts and reads in index order, so subjects that share an index
  // page cost one read. A repo the backfill has not reached yet has no row, and a repo whose keys a decision cleared
  // has null keys until the projection sweep fills them, so the keys of both come from matching_atoms.
  const stored = (ids: ReadonlyArray<RepoId>) =>
    query(
      "facets.matching",
      decodeStored,
      sql`
        with stored as (
          select repo_id, keys from repo_matching_keys
          where repo_id = any(${sql.param([...ids])}::bigint[]) and keys is not null
        ),
        held as (
          select s.repo_id, k.atom from stored s cross join unnest(s.keys) as k (atom)
          where split_part(k.atom, ':', -3) <> all(${sql.param(hiddenWires)}::text[])
        ),
        shown as (
          select s.id, s.label from subjects s
          where s.listed and s.id = any(array(
            select distinct split_part(atom, ':', -1)::bigint from held where split_part(atom, ':', -2) = 'subject'))
        ),
        m as (
          select repo_id, atom from held
          where case when split_part(atom, ':', -2) = 'subject'
            then split_part(atom, ':', -1)::bigint in (select id from shown) else true end
        )
        select
          coalesce((
            select jsonb_object_agg(repo_id::text, atoms)
            from (select repo_id, array_agg(atom order by atom) as atoms from m group by repo_id) as a
          ), '{}') as atoms,
          coalesce((select jsonb_object_agg(id::text, label) from shown), '{}') as subjects,
          array(
            select u.id::float8 from unnest(${sql.param([...ids])}::bigint[]) as u (id)
            where not exists (select 1 from stored s where s.repo_id = u.id)
          ) as missing`,
    );

  const computed = (ids: ReadonlyArray<RepoId>) =>
    query(
      "facets.matching",
      decodeMatching,
      sql`
        with m as (
          select distinct repo_id, atom from matching_atoms
          where repo_id = any(${sql.param([...ids])}::bigint[]) and listed and not qualified
            and split_part(atom, ':', -3) <> all(${sql.param(hiddenWires)}::text[])
        )
        select
          coalesce((
            select jsonb_object_agg(repo_id::text, atoms)
            from (select repo_id, array_agg(atom order by atom) as atoms from m group by repo_id) as a
          ), '{}') as atoms,
          coalesce((
            select jsonb_object_agg(s.id::text, s.label)
            from subjects s
            where s.id in (select split_part(atom, ':', -1)::bigint from m where split_part(atom, ':', -2) = 'subject')
          ), '{}') as subjects`,
    );

  const matching = (ids: ReadonlyArray<RepoId>) =>
    stored(ids).pipe(
      Effect.flatMap(([row]) =>
        row === undefined || row.missing.length === 0
          ? Effect.succeed(row === undefined ? [] : [row])
          : Effect.map(computed(row.missing), (rows) => [row, ...rows]),
      ),
      Effect.map((rows) => {
        const atoms = new Map<RepoId, ReadonlyArray<string>>();
        const labels: Record<string, string> = {};
        for (const row of rows)
          for (const [id, keys] of Object.entries(row.atoms)) {
            atoms.set(RepoId.make(Number(id)), keys);
            for (const key of keys) labels[key] ??= labelOf(key, row.subjects);
          }
        return { atoms, labels } satisfies MatchingAtoms;
      }),
    );

  // Both counts come from the nightly count, so a lookup reads no repos. A subject resolves to its canonical survivor
  // and shows only when listed and not rejected.
  const lookup = ({ q, limit }: { readonly q: string; readonly limit: number }) => {
    const prefix = labelKey(q);
    if (prefix === null) return Effect.succeed([]);
    const candidates = closedMatches(prefix).map((value) => ({
      atom: `${dimPrefix[value.dim]}:${value.id}`,
      label: value.label,
    }));
    return query(
      "facets.lookup",
      decodeLookup,
      sql`
        select
          coalesce((
            select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'repos', t.repos)
              order by t.repos desc, t.label, t.id)
            from (
              select s.id::float8 as id, s.label, s.repo_count as repos
              from (
                select distinct coalesce(c.canonical_id, l.subject_id) as id
                from knowledge_labels l
                left join subject_canonical c on c.origin_id = l.subject_id
                where l.namespace = ${namespace} and l.key like ${likePrefix(prefix)} escape '\\'
              ) as m
              join subjects s on s.id = m.id
              where s.listed and s.status <> 'rejected'
              order by s.repo_count desc, s.label, s.id
              limit ${limit}
            ) as t
          ), '[]') as subjects,
          coalesce((
            select jsonb_object_agg(a.atom, a.repos)
            from atom_stats a
            where a.atom = any(${sql.param(candidates.map((value) => value.atom))}::text[])
          ), '{}') as closed`,
    ).pipe(
      Effect.map(([row]) =>
        [
          ...(row?.subjects ?? []).map((subject) => ({
            atom: formatAtom({ role: "any", value: { dim: "subject", id: subject.id } }),
            label: subject.label,
            repos: subject.repos,
          })),
          ...candidates.map((value) => ({ ...value, repos: row?.closed[value.atom] ?? 0 })),
        ]
          .sort((a, b) => b.repos - a.repos || a.label.localeCompare(b.label))
          .slice(0, limit),
      ),
    );
  };

  return {
    held: (ids) => (ids.length === 0 ? Effect.succeed(new Map()) : held(ids)),
    matching: (ids) => (ids.length === 0 ? Effect.succeed({ atoms: new Map(), labels: {} }) : matching(ids)),
    lookup,
  } satisfies Queries;
});
