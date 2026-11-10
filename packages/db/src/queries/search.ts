import type { GitHubAccountId } from "@stargrep/github/schemas";
import { type Atom, type AtomRole, everything, type Selection } from "@stargrep/knowledge/atom";
import { SubjectId } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  type Embedding,
  type EmbeddingModelId,
  type EmbeddingModelMismatch,
  type EmbeddingVector,
  requireModel,
} from "../embedding.ts";
import { type DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { resultRows, rowsDecoder, timeParam } from "../rows.ts";
import { repoMetrics, repos, stars } from "../schema.ts";
import { any, closedTest, isClosed, subjectIndexTest, subjectTest, widens } from "./atom-predicates.ts";
import { Repo, repoColumns } from "./repos.ts";

export const MetricFamily = Schema.Literals([
  "stars",
  "forks",
  "commits",
  "active_contributors",
  "new_contributors",
  "merged_pull_requests",
  "closed_issues",
  "releases",
]);
export type MetricFamily = typeof MetricFamily.Type;

export const MetricVariant = Schema.Literals(["total", "change_30d", "change_90d", "growth_90d"]);
export type MetricVariant = typeof MetricVariant.Type;

interface FamilyColumns {
  readonly total: PgColumn;
  readonly d30: PgColumn;
  readonly d90: PgColumn;
}

const metricColumns: Readonly<Record<MetricFamily, FamilyColumns>> = {
  stars: { total: repoMetrics.stars, d30: repoMetrics.stars30d, d90: repoMetrics.stars90d },
  forks: { total: repoMetrics.forks, d30: repoMetrics.forks30d, d90: repoMetrics.forks90d },
  commits: { total: repoMetrics.commits, d30: repoMetrics.commits30d, d90: repoMetrics.commits90d },
  active_contributors: {
    total: repoMetrics.activeContributors,
    d30: repoMetrics.activeContributors30d,
    d90: repoMetrics.activeContributors90d,
  },
  new_contributors: {
    total: repoMetrics.newContributors,
    d30: repoMetrics.newContributors30d,
    d90: repoMetrics.newContributors90d,
  },
  merged_pull_requests: {
    total: repoMetrics.mergedPullRequests,
    d30: repoMetrics.mergedPullRequests30d,
    d90: repoMetrics.mergedPullRequests90d,
  },
  closed_issues: {
    total: repoMetrics.closedIssues,
    d30: repoMetrics.closedIssues30d,
    d90: repoMetrics.closedIssues90d,
  },
  releases: { total: repoMetrics.releases, d30: repoMetrics.releases30d, d90: repoMetrics.releases90d },
};

const metricExpression = (family: MetricFamily, variant: MetricVariant): SQL => {
  const { total, d30, d90 } = metricColumns[family];
  switch (variant) {
    case "total":
      return sql`${total}`;
    case "change_30d":
      return sql`${d30}`;
    case "change_90d":
      return sql`${d90}`;
    case "growth_90d":
      return sql`${d90}::float8 / nullif(${total} - ${d90}, 0)`;
  }
};

export interface SearchMetric {
  readonly id: string;
  readonly family: MetricFamily;
  readonly variant: MetricVariant;
}

export interface MetricBound {
  readonly metric: string;
  readonly op: "gt" | "gte" | "lt" | "lte";
  readonly value: number;
}

const comparison = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

export interface MetricRanking {
  readonly metric: string;
  readonly direction: "highest" | "lowest";
}

export interface SearchFilters {
  readonly archived: boolean | null;
  readonly starredAfter: DateTime.Utc | null;
  readonly starredBefore: DateTime.Utc | null;
  readonly metrics: ReadonlyArray<MetricBound>;
}

export const noFilters: SearchFilters = { archived: null, starredAfter: null, starredBefore: null, metrics: [] };

// filter keeps only matching repos, exclude drops them, and boost ranks matching candidates higher without dropping any.
export type GroupMode = "filter" | "exclude" | "boost";

// A group the query's words stated: closed atoms the compiler resolved, ORed.
export interface ClosedGroup {
  readonly _tag: "Closed";
  readonly mode: GroupMode;
  readonly any: readonly [Atom, ...Array<Atom>];
}

// A group of label keys, ORed, each reached through every role in roles. It applies only when every key names exactly
// one accepted public subject, which knowledge_key_meanings decides inside the statement.
export interface SubjectGroup {
  readonly _tag: "Subject";
  readonly mode: GroupMode;
  readonly roles: readonly [AtomRole, ...Array<AtomRole>];
  readonly keys: readonly [LabelKey, ...Array<LabelKey>];
}

export type StatedGroup = ClosedGroup | SubjectGroup;

export interface AtomQuery {
  // The caller's selection, which always filters.
  readonly explicit: Selection;
  readonly stated: ReadonlyArray<StatedGroup>;
}

export const noAtoms: AtomQuery = { explicit: everything, stated: [] };

export interface SearchScope {
  readonly kind: "stars";
  readonly accountId: GitHubAccountId;
}

export interface HybridSearch {
  readonly scope: SearchScope;
  readonly text: string;
  // Null searches full text alone.
  readonly embedding: Embedding | null;
  readonly maxDistance: number;
  readonly limit: number;
  readonly name: string | null;
  readonly metrics: ReadonlyArray<SearchMetric>;
  readonly filters: SearchFilters;
  readonly atoms: AtomQuery;
  readonly rankBy: MetricRanking | null;
}

const SearchHit = Schema.Struct({
  repo: Repo,
  nameMatch: Schema.Boolean,
  textRank: Schema.NullOr(Schema.Int),
  vectorRank: Schema.NullOr(Schema.Int),
  score: Schema.Finite,
  metrics: Schema.Array(Schema.NullOr(Schema.Finite)),
});
export type SearchHit = typeof SearchHit.Type;

// What SQL made of the atoms. stated has one entry per stated group: for a subject group, the subject each key named,
// in key order, or null when the group did not resolve, and nothing for a closed group. labels names every subject
// listed there and every explicit subject. unavailable lists the explicit subjects that are unknown, private, or
// rejected.
const Resolution = Schema.Struct({
  stated: Schema.Array(Schema.NullOr(Schema.Array(SubjectId))),
  labels: Schema.Record(Schema.String, Schema.String),
  unavailable: Schema.Array(SubjectId),
});
export type Resolution = typeof Resolution.Type;

export interface Hybrid {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly resolution: Resolution;
}

export interface PrefixSearch {
  readonly scope: SearchScope;
  readonly text: string;
}

export interface Queries {
  readonly hybrid: (
    search: HybridSearch,
  ) => Effect.Effect<Hybrid, DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch>;
  readonly matchesAsPrefix: (search: PrefixSearch) => Effect.Effect<boolean, DbQueryFailed>;
}

const rankDepth = sql.raw("100");
const fusionK = sql.raw("60");
const decodeHits = rowsDecoder(SearchHit);

// Words keep only letters and digits, so the text can never be tsquery syntax. The last word matches as a prefix.
const prefixQuery = (text: string) => {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word !== "");
  return words.length === 0
    ? null
    : words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" & ");
};

const allOf = (tests: ReadonlyArray<SQL>): SQL =>
  tests.length === 0 ? sql`true` : sql`(${sql.join([...tests], sql` and `)})`;

// A filter group that reads repo_facets. test reads r and fc and is never null. missing is its value for a repo with
// no facets row. A stated group applies only once its words resolve. A positive group of subjects alone can drive the
// index shape, and a negated one the anti shape, through a condition every match meets that a GIN index serves.
interface FacetFilter {
  readonly test: SQL;
  readonly missing: SQL;
  readonly applies: SQL | null;
  // Every key of a stated group has an accepted meaning, so it most likely applies.
  readonly likely: boolean;
  readonly drive: { readonly negated: boolean; readonly index: SQL; readonly subjects: SQL } | null;
}

interface Boost {
  readonly test: SQL;
  readonly reads: "repos" | "facets";
  readonly resolved: SQL | null;
}

const meaningOf = (group: number): SQL => sql`(select ids from meanings where grp = ${sql.raw(String(group))})`;
const originsNamed = (name: string): SQL => sql`(select ids from origins where name = ${sql.raw(`'${name}'`)})`;

// The statement's parts, from the atoms: the resolution CTEs, the closed filters on repos, the filters that read
// repo_facets, the boosts, and the envelope. Resolution reads every stated key in one inlined knowledge_key_meanings
// and every origin set in one inlined knowledge_origin_ids, so the rules are planned once per statement, not per group.
const plan = (atoms: AtomQuery, accepted: ReadonlySet<string> | null) => {
  const keyRows: Array<{ readonly group: number; readonly key: LabelKey }> = [];
  const widenings: Array<{ readonly group: number; readonly widen: boolean }> = [];
  const explicitOrigins: Array<{ readonly name: string; readonly id: SubjectId; readonly widen: boolean }> = [];
  const closedFilters: Array<SQL> = [];
  const facetFilters: Array<FacetFilter> = [];
  const boosts: Array<Boost> = [];
  const stated: Array<SQL> = [];
  const named: Array<SQL> = [];

  atoms.stated.forEach((group, k) => {
    if (group._tag === "Closed") {
      const use = group.mode === "exclude" ? "exclude" : "include";
      const test = any(group.any.filter(isClosed).map((atom) => closedTest(atom, use)));
      if (group.mode === "boost") boosts.push({ test, reads: "repos", resolved: null });
      else closedFilters.push(group.mode === "exclude" ? sql`not ${test}` : test);
      stated.push(sql`'[]'::jsonb`);
      return;
    }
    // A key that names no accepted subject, or two, cannot resolve, so its group costs the statement nothing.
    if (accepted !== null && !group.keys.every((key) => accepted.has(key))) {
      stated.push(sql`null::jsonb`);
      return;
    }
    for (const key of group.keys) keyRows.push({ group: k, key });
    for (const widen of new Set(group.roles.map(widens))) widenings.push({ group: k, widen });
    const originsOf = (role: AtomRole) => originsNamed(`s${k}_${widens(role) ? "members" : "compared"}`);
    const resolved = sql`(${meaningOf(k)} is not null)`;
    const holds = sql`coalesce(${any(group.roles.map((role) => subjectTest(role, originsOf(role))))}, false)`;
    const index = any(group.roles.map((role) => subjectIndexTest(role, originsOf(role))));
    stated.push(sql`to_jsonb(${meaningOf(k)})`);
    named.push(sql`coalesce(${meaningOf(k)}, '{}')`);
    if (group.mode === "boost") boosts.push({ test: holds, reads: "facets", resolved });
    else {
      const negated = group.mode === "exclude";
      facetFilters.push({
        test: negated ? sql`(not ${resolved} or not ${holds})` : sql`(not ${resolved} or ${holds})`,
        missing: negated ? sql`true` : sql`not ${resolved}`,
        applies: resolved,
        likely: accepted !== null,
        drive: { negated, index, subjects: meaningOf(k) },
      });
    }
  });

  for (const group of atoms.explicit.all) {
    const closedAtoms = group.any.filter(isClosed);
    const use = group.negate ? "exclude" : "include";
    const closedPart = closedAtoms.length === 0 ? null : any(closedAtoms.map((atom) => closedTest(atom, use)));
    const subjectAtoms = group.any.flatMap((atom) =>
      atom.value.dim === "subject" ? [{ role: atom.role, id: atom.value.id }] : [],
    );
    if (subjectAtoms.length === 0) {
      if (closedPart !== null) closedFilters.push(group.negate ? sql`not ${closedPart}` : closedPart);
      continue;
    }
    const subjectTests = subjectAtoms.map(({ role, id }) => {
      const name = `e${explicitOrigins.length}`;
      explicitOrigins.push({ name, id, widen: widens(role) });
      return { test: subjectTest(role, originsNamed(name)), index: subjectIndexTest(role, originsNamed(name)) };
    });
    const holds = sql`coalesce(${any([...(closedPart === null ? [] : [closedPart]), ...subjectTests.map((t) => t.test)])}, false)`;
    const closedHolds = closedPart === null ? sql`false` : closedPart;
    const ids = sql.param(subjectAtoms.map(({ id }) => id));
    facetFilters.push({
      test: group.negate ? sql`not ${holds}` : holds,
      missing: group.negate ? sql`not ${closedHolds}` : closedHolds,
      applies: null,
      likely: true,
      drive:
        closedPart === null
          ? {
              negated: group.negate,
              index: any(subjectTests.map((t) => t.index)),
              subjects: sql`(select array_agg(coalesce(c.canonical_id, t.id)) from unnest(${ids}::bigint[]) as t (id)
                left join subject_canonical c on c.origin_id = t.id)`,
            }
          : null,
    });
  }

  const explicitIds = sql.param(explicitOrigins.map(({ id }) => id));
  // Stated keys resolve to canonical subjects already. An explicit subject is labelled by its canonical subject.
  const labels = [
    ...(named.length === 0
      ? []
      : [
          sql`(select jsonb_object_agg(k.id, k.label) from subjects k where k.id = any (${sql.join(named, sql` || `)}))`,
        ]),
    ...(explicitOrigins.length === 0
      ? []
      : [
          sql`(select jsonb_object_agg(t.id, k.label) from unnest(${explicitIds}::bigint[]) as t (id)
      left join subject_canonical c on c.origin_id = t.id
      join subjects k on k.id = coalesce(c.canonical_id, t.id))`,
        ]),
  ];
  const unavailable =
    explicitOrigins.length === 0
      ? sql`'[]'::jsonb`
      : sql`coalesce((
      select jsonb_agg(t.id order by t.id)
      from unnest(${explicitIds}::bigint[]) as t (id)
      where not exists (
        select 1 from subjects s
        left join subject_canonical c on c.origin_id = s.id
        join subjects k on k.id = coalesce(c.canonical_id, s.id)
        where s.id = t.id and s.namespace = 'public' and k.status <> 'rejected')), '[]'::jsonb)`;
  const envelope =
    labels.length === 0
      ? sql`${JSON.stringify({
          stated: atoms.stated.map((group) => (group._tag === "Closed" ? [] : null)),
          labels: {},
          unavailable: [],
        })}::jsonb`
      : sql`jsonb_build_object(
    'stated', jsonb_build_array(${sql.join(stated, sql`, `)}),
    'labels', ${sql.join(
      labels.map((part) => sql`coalesce(${part}, '{}'::jsonb)`),
      sql` || `,
    )},
    'unavailable', ${unavailable})`;

  // A group's subjects, in key order, or null unless every key named exactly one.
  const meanings = sql`meanings as materialized (
    select g.grp, case when count(m.subject_id) = count(*) then array_agg(m.subject_id order by g.ord) end as ids
    from unnest(${sql.param(keyRows.map(({ group }) => group))}::int[], ${sql.param(keyRows.map(({ key }) => key))}::text[])
      with ordinality as g (grp, key, ord)
    left join knowledge_key_meanings(${sql.param([...new Set(keyRows.map(({ key }) => key))])}::text[]) as m
      on m.key = g.key
    group by g.grp
  )`;
  const sources = [
    ...(widenings.length === 0
      ? []
      : [
          sql`select 's' || m.grp || case when w.widen then '_members' else '_compared' end, m.ids, w.widen
      from meanings m
      join unnest(${sql.param(widenings.map(({ group }) => group))}::int[], ${sql.param(widenings.map(({ widen }) => widen))}::boolean[])
        as w (grp, widen) on w.grp = m.grp
      where m.ids is not null`,
        ]),
    ...(explicitOrigins.length === 0
      ? []
      : [
          sql`select e.name, array[e.id], e.widen
      from unnest(${sql.param(explicitOrigins.map(({ name }) => name))}::text[], ${explicitIds}::bigint[],
        ${sql.param(explicitOrigins.map(({ widen }) => widen))}::boolean[]) as e (name, id, widen)`,
        ]),
  ];
  // The origin IDs each resolved group and each explicit subject reaches, through the inlined rule.
  const origins = sql`origins as materialized (
    select w.name, array(select x.origin_id from knowledge_origin_ids(w.subjects, w.widen) as x) as ids
    from (${sql.join(sources, sql` union all `)}) as w (name, subjects, widen)
  )`;
  const resolution = [...(keyRows.length === 0 ? [] : [meanings]), ...(sources.length === 0 ? [] : [origins])];
  return { resolution, closedFilters, facetFilters, boosts, envelope };
};

// The statement for one search. Every pipeline is today's: the account's stars joined to repos, full text and vectors
// ranked to 100 each, and reciprocal rank fusion. Closed atoms add array tests on the repos row. A filter that reads
// repo_facets adds up to three complete pipelines and a choice at the top, so exactly one runs: a, today's, when no such
// filter resolved; b, the index shape, which reads the filter's matches from a GIN index, when they fit in the account's
// star count; and c, the probe shape, one primary-key read of repo_facets per starred repo, otherwise. A boost is a
// third rank list over the fused candidates.
const ranked = (
  search: HybridSearch,
  vector: EmbeddingVector | null,
  model: EmbeddingModelId,
  accepted: ReadonlySet<string> | null,
) => {
  const aliases = new Map(search.metrics.map((metric, index) => [metric.id, sql.raw(`m${index}`)]));
  const alias = (metricId: string) => {
    const found = aliases.get(metricId);
    if (found === undefined) throw new Error(`search.hybrid names metric '${metricId}' outside search.metrics`);
    return found;
  };
  const carry = (from: string) => sql.join([...aliases.values()].map((name) => sql`, ${sql.raw(from)}.${name}`));
  const { filters, rankBy } = search;
  const account = search.scope.accountId;
  const parts = plan(search.atoms, accepted);
  const lateral =
    search.metrics.length === 0
      ? sql``
      : sql`left join lateral (
          select ${sql.join(
            search.metrics.map(
              (metric) => sql`(${metricExpression(metric.family, metric.variant)})::float8 as ${alias(metric.id)}`,
            ),
            sql`, `,
          )}
          from ${repoMetrics} where ${repoMetrics.repoId} = r.id
        ) metric on true`;
  const name =
    search.name === null
      ? sql`false`
      : sql`(lower(r.name) = lower(${search.name}) or lower(r.owner || '/' || r.name) = lower(${search.name}))`;
  const distance =
    vector === null
      ? sql`null::float8`
      : sql`case when r.embedding_model = ${model} then r.embedding <=> ${`[${vector.join(",")}]`}::halfvec end`;
  const where = allOf([
    sql`s.account_id = ${account}`,
    sql`s.unstarred_at is null`,
    sql`r.gone_at is null`,
    ...(filters.archived === null ? [] : [sql`r.archived = ${filters.archived}`]),
    ...(filters.starredAfter === null ? [] : [sql`s.starred_at >= ${timeParam(filters.starredAfter)}`]),
    ...(filters.starredBefore === null ? [] : [sql`s.starred_at < ${timeParam(filters.starredBefore)}`]),
    ...filters.metrics.map(
      (bound) => sql`metric.${alias(bound.metric)} ${sql.raw(comparison[bound.op])} ${bound.value}::float8`,
    ),
    ...parts.closedFilters,
  ]);

  const facetBoosts = parts.boosts.filter((boost) => boost.reads === "facets");
  const reposBoosts = parts.boosts.filter((boost) => boost.reads === "repos");
  const matches = sql.join(
    [
      ...(reposBoosts.length === 0
        ? []
        : [
            sql`coalesce((select ${sql.join(
              reposBoosts.map((boost) => sql`(${boost.test})::int`),
              sql` + `,
            )} from repos r where r.id = p.id), 0)`,
          ]),
      ...(facetBoosts.length === 0
        ? []
        : [
            sql`case when ${sql.join(
              facetBoosts.map((boost) => boost.resolved ?? sql`true`),
              sql` or `,
            )} then coalesce((select ${sql.join(
              facetBoosts.map((boost) => sql`(${boost.resolved ?? sql`true`} and ${boost.test})::int`),
              sql` + `,
            )} from repo_facets fc where fc.repo_id = p.id), 0) else 0 end`,
          ]),
    ],
    sql` + `,
  );
  const boosted = parts.boosts.length > 0;

  const pipeline = (suffix: string, from: SQL, extra: ReadonlyArray<SQL>) => {
    const x = (cte: string) => sql.raw(`${cte}${suffix}`);
    return sql`${x("scored")} as materialized (
    select r.id ${carry("metric")},
      case when r.search @@ query then ts_rank_cd(r.search, query) end as text_score,
      ${distance} as distance,
      ${name} as name_match
    from ${from}
    ${lateral},
    websearch_to_tsquery('english', ${search.text}) query
    where ${allOf([where, ...extra])}
  ),
  ${x("text_hits")} as (
    select id, row_number() over (order by text_score desc, id) as rank from (
      select id, text_score from ${x("scored")} where text_score is not null
      order by text_score desc, id
      limit ${rankDepth}
    ) top
  ),
  ${x("vector_hits")} as (
    select id, row_number() over (order by distance, id) as rank from (
      select id, distance from ${x("scored")} where distance <= ${search.maxDistance}::float8
      order by distance, id
      limit ${rankDepth}
    ) top
  ),
  ${x("pool")} as ${boosted ? sql`materialized` : sql``} (
    select s.id, s.name_match, s.text_score, s.distance, t.rank as text_rank, v.rank as vector_rank ${carry("s")}
    from ${x("scored")} s
    left join ${x("text_hits")} t on t.id = s.id
    left join ${x("vector_hits")} v on v.id = s.id
    where t.id is not null or v.id is not null or s.name_match
  ),
  ${
    boosted
      ? sql`${x("boost")} as (
    select p.id, row_number() over (
      order by n.matches desc, p.distance nulls last, p.text_score desc nulls last, p.id) as rank
    from ${x("pool")} p
    cross join lateral (select ${matches} as matches) as n
    where n.matches > 0
  ),`
      : sql``
  }
  ${x("best")} as (
    select p.id, p.name_match, p.text_rank, p.vector_rank,
      (coalesce(1.0 / (${fusionK} + p.text_rank), 0) + coalesce(1.0 / (${fusionK} + p.vector_rank), 0)
        ${boosted ? sql`+ coalesce(1.0 / (${fusionK} + b.rank), 0)` : sql``})::float8 as relevance
      ${carry("p")}
    from ${x("pool")} p
    ${boosted ? sql`left join ${x("boost")} b on b.id = p.id` : sql``}
  ),
  ${x("pick")} as (select * from ${x("best")} order by name_match desc, relevance desc, id limit ${search.limit})`;
  };

  const starsJoin = sql`stars s join repos r on r.id = s.repo_id`;
  const ctes: Array<SQL> = [...parts.resolution];
  const picks: Array<SQL> = [];
  const facets = parts.facetFilters;
  if (facets.length === 0) {
    ctes.push(pipeline("", starsJoin, []));
    picks.push(sql`select * from pick`);
  } else {
    const test = allOf(facets.map((filter) => filter.test));
    const missing = allOf(facets.map((filter) => filter.missing));
    const conditional = facets.flatMap((filter) => (filter.applies === null ? [] : [filter.applies]));
    // Today's pipeline runs when no stated filter resolved. When every filter's keys have an accepted meaning, it is
    // left out, and a filter that still fails to resolve passes every row of the probe shape.
    const today = conditional.length === facets.length && facets.some((filter) => !filter.likely);
    const applies = conditional.length === facets.length ? sql`(${sql.join(conditional, sql` or `)})` : sql`true`;
    const explicitDriver = facets.find(
      (filter) => filter.applies === null && filter.drive !== null && !filter.drive.negated,
    );
    const statedDrivers = facets.filter(
      (filter) => filter.applies !== null && filter.drive !== null && !filter.drive.negated,
    );
    const drivers = explicitDriver === undefined ? statedDrivers : [explicitDriver];
    const anti = drivers.length === 0 && facets.every((filter) => filter.drive?.negated === true);
    const shaped = drivers.length > 0 ? drivers : anti ? facets : [];
    const index = sql.join(
      shaped.map((filter) => filter.drive?.index ?? sql`false`),
      sql` or `,
    );
    const subjects = sql.join(
      shaped.map((filter) => sql`coalesce(${filter.drive?.subjects ?? sql`null`}, '{}')`),
      sql` || `,
    );
    const ready = sql.join(
      shaped.map((filter) => filter.applies ?? sql`true`),
      sql` or `,
    );
    if (shaped.length > 0) {
      ctes.push(sql`account as materialized (
    select coalesce((select starred_count from github_accounts where id = ${account}), 0) as stars
  )`);
      // subjects.repo_count, the nightly count, skips a scan that would pass the account's size. The limit stays as the
      // safety net for a stale count.
      ctes.push(sql`reach as materialized (
    select ${applies} as applies,
      (${ready}) and (select coalesce(sum(repo_count), 0) from subjects where id = any ((${subjects})::bigint[]))
        <= (select stars from account) as scan
  )`);
      ctes.push(
        anti
          ? sql`excluded as materialized (
    select fc.repo_id from repo_facets fc
    where (select scan from reach) and (${index}) and not ${test}
    limit (select stars + 1 from account)
  )`
          : sql`matched as materialized (
    select fc.repo_id, fc.members, fc.for_subjects, fc.built_with, fc.about, fc.traits, fc.tagged, fc.alternative_to,
      fc.replaced_by
    from repo_facets fc
    where (select scan from reach) and (${index})
    limit (select stars + 1 from account)
  )`,
      );
      ctes.push(sql`shape as materialized (
    select case
      when not applies then ${sql.raw(today ? "'a'" : "'c'")}
      when scan and (select count(*) from ${sql.raw(anti ? "excluded" : "matched")}) <= (select stars from account) then 'b'
      else 'c' end as route
    from reach
  )`);
    } else {
      ctes.push(
        today
          ? sql`shape as materialized (select case when ${applies} then 'c' else 'a' end as route)`
          : sql`shape as materialized (select 'c' as route)`,
      );
    }
    if (today) {
      ctes.push(pipeline("_a", starsJoin, []));
      picks.push(sql`select * from pick_a where (select route from shape) = 'a'`);
    }
    if (shaped.length > 0) {
      ctes.push(
        anti
          ? pipeline("_b", starsJoin, [sql`not exists (select 1 from excluded e where e.repo_id = s.repo_id)`])
          : pipeline(
              "_b",
              sql`matched fc join stars s on s.account_id = ${account} and s.repo_id = fc.repo_id
    join repos r on r.id = fc.repo_id`,
              [test],
            ),
      );
      picks.push(sql`select * from pick_b where (select route from shape) = 'b'`);
    }
    ctes.push(
      pipeline("_c", starsJoin, [
        sql`coalesce((select ${test} from repo_facets fc where fc.repo_id = s.repo_id), ${missing})`,
      ]),
    );
    picks.push(sql`select * from pick_c where (select route from shape) = 'c'`);
  }
  ctes.push(sql`applied as (select ${parts.envelope} as envelope)`);

  const metricOrder =
    rankBy === null
      ? sql``
      : sql`h.${alias(rankBy.metric)} ${sql.raw(rankBy.direction === "highest" ? "desc" : "asc")} nulls last,`;
  return sql`
  with ${sql.join(ctes, sql`,\n  `)}
  select a.envelope, h.id, h.name_match, h.text_rank, h.vector_rank, h.relevance,
    array[${sql.join(
      [...aliases.values()].map((name) => sql`h.${name}`),
      sql`, `,
    )}]::float8[] as metrics,
    row_number() over (order by h.name_match desc, ${metricOrder} h.relevance desc, h.id) as position
  from applied a
  left join lateral (${sql.join(picks, sql` union all `)}) h on true`;
};

// The statement search.hybrid runs, which the latency benchmark renders too.
export const hybridQuery = (
  db: Postgres.Database,
  search: HybridSearch,
  vector: EmbeddingVector | null,
  model: EmbeddingModelId,
  accepted: ReadonlySet<string> | null = null,
) => {
  const hits = db
    .$with("ranked", {
      envelope: sql<unknown>`envelope`.as("envelope"),
      id: sql<number>`id`.mapWith(Number).as("id"),
      nameMatch: sql<boolean>`name_match`.as("name_match"),
      textRank: sql<number | null>`text_rank`.mapWith(Number).as("text_rank"),
      vectorRank: sql<number | null>`vector_rank`.mapWith(Number).as("vector_rank"),
      score: sql<number>`relevance`.mapWith(Number).as("relevance"),
      metrics: sql<ReadonlyArray<number | null>>`metrics`.as("metrics"),
      position: sql<number>`position`.mapWith(Number).as("position"),
    })
    .as(ranked(search, vector, model, accepted));
  return db
    .with(hits)
    .select({
      envelope: hits.envelope,
      repo: repoColumns,
      nameMatch: hits.nameMatch,
      textRank: hits.textRank,
      vectorRank: hits.vectorRank,
      score: hits.score,
      metrics: hits.metrics,
    })
    .from(hits)
    .leftJoin(repos, eq(repos.id, hits.id))
    .orderBy(hits.position);
};

// The label keys that name an accepted public subject, as one isolate last read them.
export interface AcceptedKeys {
  readonly keys: ReadonlySet<string>;
  readonly readAt: number;
}

// A subject accepted since the last read applies to stated words within this long.
export const acceptedKeysTtl = Duration.minutes(5);

const decodeKeys = rowsDecoder(Schema.Struct({ key: Schema.String }));

export const make = Effect.fn("Db.search.make")(function* (
  configuredModel: EmbeddingModelId,
  acceptedKeys?: Ref.Ref<Option.Option<AcceptedKeys>>,
) {
  const { run } = yield* Postgres.Postgres;
  const decodeResolution = Schema.decodeUnknownEffect(Resolution);

  // Every key that names exactly one accepted public subject, the rule knowledge_key_meanings applies, so an ambiguous
  // key never reaches the statement. Null when no cache was given, so SQL resolves every key.
  const accepted = Effect.fnUntraced(function* () {
    if (acceptedKeys === undefined) return null;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(acceptedKeys);
    if (Option.isSome(cached) && now - cached.value.readAt < Duration.toMillis(acceptedKeysTtl)) {
      return cached.value.keys;
    }
    const rows = yield* run("search.acceptedKeys", (db) =>
      db.execute(sql`select l.key from knowledge_labels l
        left join subject_canonical c on c.origin_id = l.subject_id
        join subjects s on s.id = coalesce(c.canonical_id, l.subject_id) and s.status = 'accepted'
        where l.namespace = 'public'
        group by l.key
        having count(distinct s.id) = 1`),
    ).pipe(Effect.flatMap((result) => decodeKeys("search.acceptedKeys")(resultRows(result))));
    const keys: ReadonlySet<string> = new Set(rows.map(({ key }) => key));
    yield* Ref.set(acceptedKeys, Option.some({ keys, readAt: now }));
    return keys;
  });

  return {
    hybrid: Effect.fnUntraced(function* (search: HybridSearch) {
      const vector = search.embedding === null ? null : yield* requireModel(configuredModel, search.embedding);
      const keys = search.atoms.stated.some((group) => group._tag === "Subject") ? yield* accepted() : null;
      const rows = yield* run("search.hybrid", (db) => hybridQuery(db, search, vector, configuredModel, keys));
      const resolution = yield* decodeResolution(rows[0]?.envelope).pipe(
        Effect.mapError(() => new DbRowInvalid({ operation: "search.hybrid", column: "envelope" })),
      );
      const hits = yield* decodeHits("search.hybrid")(rows.filter((row) => row.repo !== null));
      return { hits, resolution } satisfies Hybrid;
    }),
    matchesAsPrefix: ({ scope, text }) => {
      const query = prefixQuery(text);
      if (query === null) return Effect.succeed(false);
      return run("search.matchesAsPrefix", (db) =>
        db
          .select({ id: stars.repoId })
          .from(stars)
          .innerJoin(repos, eq(repos.id, stars.repoId))
          .where(
            and(
              eq(stars.accountId, scope.accountId),
              isNull(stars.unstarredAt),
              sql`${repos.search} @@ to_tsquery('english', ${query})`,
            ),
          )
          .limit(1),
      ).pipe(Effect.map((rows) => rows.length > 0));
    },
  } satisfies Queries;
});
