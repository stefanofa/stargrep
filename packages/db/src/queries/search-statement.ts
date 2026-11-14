import { type AtomRole, isClosed } from "@stargrep/knowledge/atom";
import type { SubjectId } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { eq, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type { EmbeddingModelId, EmbeddingVector } from "../embedding.ts";
import type * as Postgres from "../postgres.ts";
import { timeParam } from "../rows.ts";
import { repoMetrics, repos } from "../schema.ts";
import { allOf, anyOf, closedTest, subjectIndexTest, subjectTest, widens } from "./atom-predicates.ts";
import { repoColumns } from "./repos.ts";
import type { AtomQuery, HybridSearch, MetricFamily, MetricVariant, NameSearch, SearchScope } from "./search.ts";

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

const comparison = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

const rankDepth = sql.raw("100");
const fusionK = sql.raw("60");

// A filter group that reads repo_facets. test reads r and fc and is never null. missing is its value for a repo with
// no facets row. A stated group applies only once its words resolve, which resolved tests. A positive group of subjects
// alone can drive the index shape, and a negated one the anti shape, through index, a condition every match meets that
// a GIN index serves, and subjects, the subjects it reaches.
export type FacetFilter =
  | {
      readonly _tag: "Stated";
      readonly negated: boolean;
      readonly test: SQL;
      readonly missing: SQL;
      readonly resolved: SQL;
      readonly index: SQL;
      readonly subjects: SQL;
    }
  | {
      readonly _tag: "Explicit";
      readonly negated: boolean;
      readonly test: SQL;
      readonly missing: SQL;
      // Null when the group mixes closed atoms, so it cannot drive the index shape.
      readonly drive: { readonly index: SQL; readonly subjects: SQL } | null;
    };

// A filter that drives the index or anti shape. ready is true once its subjects are known.
export interface Driver {
  readonly index: SQL;
  readonly subjects: SQL;
  readonly ready: SQL;
}

// Probe reads repo_facets once per starred repo. Index reads the drivers' matches from a GIN index, or with anti the
// repos they exclude, and falls back to the probe when those do not fit in the account's star count.
export type Route =
  | { readonly _tag: "Probe" }
  | { readonly _tag: "Index"; readonly anti: boolean; readonly drivers: Arr.NonEmptyReadonlyArray<Driver> };

const driverOf = (filter: FacetFilter): Driver | null =>
  filter._tag === "Stated"
    ? { index: filter.index, subjects: filter.subjects, ready: filter.resolved }
    : filter.drive === null
      ? null
      : { ...filter.drive, ready: sql`true` };

// A positive explicit group of subjects alone drives the index shape, else every positive stated group does. With no
// positive driver, the anti shape runs when every filter is a negated group that can drive.
export const route = (filters: ReadonlyArray<FacetFilter>): Route => {
  const explicit = filters.find((filter) => filter._tag === "Explicit" && !filter.negated && filter.drive !== null);
  const positive =
    explicit === undefined ? filters.filter((filter) => filter._tag === "Stated" && !filter.negated) : [explicit];
  const anti = positive.length === 0 && filters.every((filter) => filter.negated && driverOf(filter) !== null);
  const drivers = (anti ? filters : positive).flatMap((filter) => driverOf(filter) ?? []);
  return Arr.isReadonlyArrayNonEmpty(drivers) ? { _tag: "Index", anti, drivers } : { _tag: "Probe" };
};

const meaningOf = (group: number): SQL => sql`(select ids from meanings where grp = ${sql.raw(String(group))})`;
const originsNamed = (name: string): SQL => sql`(select ids from origins where name = ${sql.raw(`'${name}'`)})`;

// The statement's parts, from the atoms: the resolution CTEs, the closed filters and boosts on repos, the filters and
// boosts that read repo_facets, and the envelope. Resolution reads every stated key in one inlined
// knowledge_key_meanings and every origin set in one inlined knowledge_origin_ids, so the rules are planned once per
// statement, not per group.
const atomParts = (atoms: AtomQuery, accepted: ReadonlySet<string>) => {
  const keyRows: Array<{ readonly group: number; readonly key: LabelKey }> = [];
  const widenings: Array<{ readonly group: number; readonly widen: boolean }> = [];
  const explicitOrigins: Array<{ readonly name: string; readonly id: SubjectId; readonly widen: boolean }> = [];
  const closedFilters: Array<SQL> = [];
  const facetFilters: Array<FacetFilter> = [];
  const closedBoosts: Array<SQL> = [];
  const subjectBoosts: Array<{ readonly test: SQL; readonly resolved: SQL }> = [];
  const stated: Array<SQL> = [];
  const named: Array<SQL> = [];

  atoms.stated.forEach((group, k) => {
    if (group._tag === "Closed") {
      const use = group.mode === "exclude" ? "exclude" : "include";
      const test = anyOf(Arr.map(group.any, (atom) => closedTest(atom, use)));
      if (group.mode === "boost") closedBoosts.push(test);
      else closedFilters.push(group.mode === "exclude" ? sql`not ${test}` : test);
      stated.push(sql`'[]'::jsonb`);
      return;
    }
    // A key that names no accepted subject, or two, cannot resolve, so its group costs the statement nothing.
    if (!group.keys.every((key) => accepted.has(key))) {
      stated.push(sql`null::jsonb`);
      return;
    }
    for (const key of group.keys) keyRows.push({ group: k, key });
    for (const widen of new Set(group.roles.map(widens))) widenings.push({ group: k, widen });
    const originsOf = (role: AtomRole) => originsNamed(`s${k}_${widens(role) ? "members" : "compared"}`);
    const resolved = sql`(${meaningOf(k)} is not null)`;
    const holds = sql`coalesce(${anyOf(Arr.map(group.roles, (role) => subjectTest(role, originsOf(role))))}, false)`;
    const index = anyOf(Arr.map(group.roles, (role) => subjectIndexTest(role, originsOf(role))));
    stated.push(sql`to_jsonb(${meaningOf(k)})`);
    named.push(sql`coalesce(${meaningOf(k)}, '{}')`);
    if (group.mode === "boost") subjectBoosts.push({ test: holds, resolved });
    else {
      const negated = group.mode === "exclude";
      facetFilters.push({
        _tag: "Stated",
        negated,
        test: negated ? sql`(not ${resolved} or not ${holds})` : sql`(not ${resolved} or ${holds})`,
        missing: negated ? sql`true` : sql`not ${resolved}`,
        resolved,
        index,
        subjects: meaningOf(k),
      });
    }
  });

  for (const group of atoms.explicit.all) {
    const closedAtoms = group.any.filter(isClosed);
    const use = group.negate ? "exclude" : "include";
    const closedPart = Arr.isReadonlyArrayNonEmpty(closedAtoms)
      ? anyOf(Arr.map(closedAtoms, (atom) => closedTest(atom, use)))
      : null;
    const subjectAtoms = group.any.flatMap((atom) =>
      atom.value.dim === "subject" ? [{ role: atom.role, id: atom.value.id }] : [],
    );
    if (!Arr.isReadonlyArrayNonEmpty(subjectAtoms)) {
      if (closedPart !== null) closedFilters.push(group.negate ? sql`not ${closedPart}` : closedPart);
      continue;
    }
    const subjectTests = Arr.map(subjectAtoms, ({ role, id }) => {
      const name = `e${explicitOrigins.length}`;
      explicitOrigins.push({ name, id, widen: widens(role) });
      return { test: subjectTest(role, originsNamed(name)), index: subjectIndexTest(role, originsNamed(name)) };
    });
    const tests = Arr.map(subjectTests, ({ test }) => test);
    const holds = sql`coalesce(${anyOf(closedPart === null ? tests : [closedPart, ...tests])}, false)`;
    const closedHolds = closedPart === null ? sql`false` : closedPart;
    const ids = sql.param(subjectAtoms.map(({ id }) => id));
    facetFilters.push({
      _tag: "Explicit",
      negated: group.negate,
      test: group.negate ? sql`not ${holds}` : holds,
      missing: group.negate ? sql`not ${closedHolds}` : closedHolds,
      drive:
        closedPart === null
          ? {
              index: anyOf(Arr.map(subjectTests, ({ index }) => index)),
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
  return { resolution, closedFilters, facetFilters, closedBoosts, subjectBoosts, envelope };
};

// The account's current stars, read as stars s joined to repos r.
const starredBy = (scope: SearchScope) =>
  [sql`s.account_id = ${scope.accountId}`, sql`s.unstarred_at is null`, sql`r.gone_at is null`] as const;

// Reads s's repo_facets row by primary key and tests every facet filter, or missing when the repo has no row.
const probeTest = (facets: Arr.NonEmptyReadonlyArray<FacetFilter>): SQL => {
  const test = allOf(Arr.map(facets, (filter) => filter.test));
  const missing = allOf(Arr.map(facets, (filter) => filter.missing));
  return sql`coalesce((select ${test} from repo_facets fc where fc.repo_id = s.repo_id), ${missing})`;
};

// The statement for one search. Every pipeline is the same: the account's stars joined to repos, full text and vectors
// ranked to 100 each, and reciprocal rank fusion. Closed atoms add array tests on the repos row. Filters that read
// repo_facets run the probe pipeline, c, which reads repo_facets by primary key once per starred repo. When the route
// has drivers, the index pipeline, b, runs beside it, and a choice at the top picks b when the drivers' matches fit in
// the account's star count. A boost is a third rank list over the fused candidates.
const ranked = (
  search: HybridSearch,
  vector: EmbeddingVector | null,
  model: EmbeddingModelId,
  accepted: ReadonlySet<string>,
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
  const parts = atomParts(search.atoms, accepted);
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
    ...starredBy(search.scope),
    ...(filters.archived === null ? [] : [sql`r.archived = ${filters.archived}`]),
    ...(filters.starredAfter === null ? [] : [sql`s.starred_at >= ${timeParam(filters.starredAfter)}`]),
    ...(filters.starredBefore === null ? [] : [sql`s.starred_at < ${timeParam(filters.starredBefore)}`]),
    ...filters.metrics.map(
      (bound) => sql`metric.${alias(bound.metric)} ${sql.raw(comparison[bound.op])} ${bound.value}::float8`,
    ),
    ...parts.closedFilters,
  ]);

  const { closedBoosts, subjectBoosts } = parts;
  const matches = sql.join(
    [
      ...(closedBoosts.length === 0
        ? []
        : [
            sql`coalesce((select ${sql.join(
              closedBoosts.map((test) => sql`(${test})::int`),
              sql` + `,
            )} from repos r where r.id = p.id), 0)`,
          ]),
      ...(subjectBoosts.length === 0
        ? []
        : [
            sql`case when ${sql.join(
              subjectBoosts.map((boost) => boost.resolved),
              sql` or `,
            )} then coalesce((select ${sql.join(
              subjectBoosts.map((boost) => sql`(${boost.resolved} and ${boost.test})::int`),
              sql` + `,
            )} from repo_facets fc where fc.repo_id = p.id), 0) else 0 end`,
          ]),
    ],
    sql` + `,
  );
  const boosted = closedBoosts.length > 0 || subjectBoosts.length > 0;

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
  if (!Arr.isReadonlyArrayNonEmpty(facets)) {
    ctes.push(pipeline("", starsJoin, []));
    picks.push(sql`select * from pick`);
  } else {
    const test = allOf(Arr.map(facets, (filter) => filter.test));
    const probe = pipeline("_c", starsJoin, [probeTest(facets)]);
    const shape = route(facets);
    if (shape._tag === "Probe") {
      ctes.push(probe);
      picks.push(sql`select * from pick_c`);
    } else {
      const { anti, drivers } = shape;
      const index = sql.join(
        drivers.map((driver) => driver.index),
        sql` or `,
      );
      const subjects = sql.join(
        drivers.map((driver) => sql`coalesce(${driver.subjects}, '{}')`),
        sql` || `,
      );
      const ready = sql.join(
        drivers.map((driver) => driver.ready),
        sql` or `,
      );
      ctes.push(sql`account as materialized (
    select coalesce((select starred_count from github_accounts where id = ${account}), 0) as stars
  )`);
      // subjects.repo_count, the nightly count, skips a scan that would pass the account's size. The limit stays as the
      // safety net for a stale count.
      ctes.push(sql`reach as materialized (
    select (${ready}) and (select coalesce(sum(repo_count), 0) from subjects where id = any ((${subjects})::bigint[]))
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
      when scan and (select count(*) from ${sql.raw(anti ? "excluded" : "matched")}) <= (select stars from account) then 'b'
      else 'c' end as route
    from reach
  )`);
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
      ctes.push(probe);
      picks.push(sql`select * from pick_b where (select route from shape) = 'b'`);
      picks.push(sql`select * from pick_c where (select route from shape) = 'c'`);
    }
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

// The statement search.hybrid runs. accepted holds the label keys that name exactly one accepted subject.
export const hybridQuery = (
  db: Postgres.Database,
  search: HybridSearch,
  vector: EmbeddingVector | null,
  model: EmbeddingModelId,
  accepted: ReadonlySet<string>,
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

// Every spelling at most one edit from a word of letters and digits, as regular expression alternatives: the word,
// and the word with one character dropped, changed, or added, or two neighbors swapped.
const oneEdit = (word: string) => {
  const any = "[a-z0-9]";
  const spellings = new Set([word]);
  for (let index = 0; index <= word.length; index++) {
    const [before, after] = [word.slice(0, index), word.slice(index)];
    spellings.add(`${before}${any}${after}`);
    if (after === "") continue;
    spellings.add(`${before}${after.slice(1)}`);
    spellings.add(`${before}${any}${after.slice(1)}`);
    if (after.length > 1) spellings.add(`${before}${after[1]}${after[0]}${after.slice(2)}`);
  }
  return [...spellings].join("|");
};

// The statement search.nearNames runs for word, the typed text's letters and digits run together. The caller's
// selection applies as hybridQuery's probe pipeline applies it.
export const nearNamesQuery = (db: Postgres.Database, word: string, search: Omit<NameSearch, "text">) => {
  const spellings = oneEdit(word);
  const whole = `^(${spellings})$`;
  const [shortest, longest] = [word.length - 1, word.length + 1];
  // One edit leaves the first or the last of these many characters as typed, so only a name holding one of them pays
  // for the regular expression, which is slow over thousands of stars.
  const kept = Math.floor((word.length - 1) / 2);
  const [head, tail] = [word.slice(0, kept), word.slice(word.length - kept)];
  const together = (value: SQL) => sql`regexp_replace(lower(${value}), '[^a-z0-9]', '', 'g')`;
  const spelled = (value: SQL) => sql`(length(${value}) between ${shortest} and ${longest} and ${value} ~ ${whole})`;
  const parts = atomParts({ explicit: search.explicit, stated: [] }, new Set());
  const facets = parts.facetFilters;
  const where = allOf([
    ...starredBy(search.scope),
    ...parts.closedFilters,
    ...(Arr.isReadonlyArrayNonEmpty(facets) ? [probeTest(facets)] : []),
    sql`(${spelled(together(sql`r.name`))}
      or ${spelled(together(sql`r.owner || r.name`))}
      or ((strpos(lower(r.name), ${head}) > 0 or strpos(lower(r.name), ${tail}) > 0)
        and lower(r.name) ~ ${`(^|[^a-z0-9])(${spellings})([^a-z0-9]|$)`}))`,
  ]);
  const near = db
    .$with("near", {
      id: sql<number>`id`.mapWith(Number).as("id"),
      position: sql<number>`position`.mapWith(Number).as("position"),
    })
    .as(sql`${parts.resolution.length === 0 ? sql`` : sql`with ${sql.join(parts.resolution, sql`, `)}`}
  select r.id, row_number() over (order by length(r.name), r.owner, r.name) as position
  from stars s join repos r on r.id = s.repo_id
  where ${where}
  order by position
  limit ${search.limit}`);
  return db
    .with(near)
    .select({ repo: repoColumns })
    .from(near)
    .innerJoin(repos, eq(repos.id, near.id))
    .orderBy(near.position);
};
