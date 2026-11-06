import type { GitHubAccountId } from "@stargrep/github/schemas";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type Embedding,
  type EmbeddingModelId,
  type EmbeddingModelMismatch,
  type EmbeddingVector,
  requireModel,
} from "../embedding.ts";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, timeParam } from "../rows.ts";
import { repoMetrics, repos, stars } from "../schema.ts";
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
  readonly languages: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<string>;
  readonly licenses: ReadonlyArray<string>;
  readonly archived: boolean | null;
  readonly starredAfter: DateTime.Utc | null;
  readonly starredBefore: DateTime.Utc | null;
  readonly metrics: ReadonlyArray<MetricBound>;
}

export const noFilters: SearchFilters = {
  languages: [],
  kinds: [],
  licenses: [],
  archived: null,
  starredAfter: null,
  starredBefore: null,
  metrics: [],
};

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

export interface PrefixSearch {
  readonly scope: SearchScope;
  readonly text: string;
}

export interface Queries {
  readonly hybrid: (
    search: HybridSearch,
  ) => Effect.Effect<ReadonlyArray<SearchHit>, DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch>;
  readonly matchesAsPrefix: (search: PrefixSearch) => Effect.Effect<boolean, DbQueryFailed>;
}

const rankDepth = sql.raw("100");
const fusionK = sql.raw("60");
const decodeHits = rowsDecoder(SearchHit);

const anyOf = (column: SQL, values: ReadonlyArray<string>) =>
  values.length === 0
    ? sql``
    : sql` and lower(${column}) = any(${sql.param(values.map((value) => value.toLowerCase()))}::text[])`;

const languageClause = (languages: ReadonlyArray<string>) => {
  if (languages.length === 0) return sql``;
  const names = sql.param(languages.map((language) => language.toLowerCase()));
  return sql` and (lower(${repos.language}) = any(${names}::text[]) or jsonb_exists_any(${repos.topics}, ${names}::text[]))`;
};

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

const ranked = (search: HybridSearch, vector: EmbeddingVector | null, model: EmbeddingModelId) => {
  const aliases = new Map(search.metrics.map((metric, index) => [metric.id, sql.raw(`m${index}`)]));
  const alias = (metricId: string) => {
    const found = aliases.get(metricId);
    if (found === undefined) throw new Error(`search.hybrid names metric '${metricId}' outside search.metrics`);
    return found;
  };
  const relevance = sql`coalesce(1.0 / (${fusionK} + text_hits.rank), 0) + coalesce(1.0 / (${fusionK} + vector_hits.rank), 0)`;
  const carry = (from: string) => sql.join([...aliases.values()].map((name) => sql`, ${sql.raw(from)}.${name}`));
  const { filters, rankBy } = search;
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
          from ${repoMetrics} where ${repoMetrics.repoId} = ${repos.id}
        ) metric on true`;
  const name =
    search.name === null
      ? sql`false`
      : sql`(lower(${repos.name}) = lower(${search.name}) or lower(${repos.owner} || '/' || ${repos.name}) = lower(${search.name}))`;
  const metricOrder =
    rankBy === null
      ? sql``
      : sql`${alias(rankBy.metric)} ${sql.raw(rankBy.direction === "highest" ? "desc" : "asc")} nulls last,`;
  return sql`
  with scored as materialized (
    select
      ${repos.id} as id ${carry("metric")},
      case when ${repos.search} @@ query then ts_rank_cd(${repos.search}, query) end as text_score,
      ${
        vector === null
          ? sql`null::float8`
          : sql`case when ${repos.embeddingModel} = ${model}
        then ${repos.embedding} <=> ${`[${vector.join(",")}]`}::halfvec end`
      } as distance,
      ${name} as name_match
    from ${stars}
    join ${repos} on ${repos.id} = ${stars.repoId}
    ${lateral},
    websearch_to_tsquery('english', ${search.text}) query
    where ${stars.accountId} = ${search.scope.accountId} and ${stars.unstarredAt} is null
    ${languageClause(filters.languages)}
    ${anyOf(sql`${repos.kind}`, filters.kinds)}
    ${anyOf(sql`${repos.license}`, filters.licenses)}
    ${filters.archived === null ? sql`` : sql` and ${repos.archived} = ${filters.archived}`}
    ${filters.starredAfter === null ? sql`` : sql` and ${stars.starredAt} >= ${timeParam(filters.starredAfter)}`}
    ${filters.starredBefore === null ? sql`` : sql` and ${stars.starredAt} < ${timeParam(filters.starredBefore)}`}
    ${sql.join(
      filters.metrics.map(
        (bound) => sql` and metric.${alias(bound.metric)} ${sql.raw(comparison[bound.op])} ${bound.value}::float8`,
      ),
    )}
  ),
  text_hits as (
    select id, row_number() over (order by text_score desc, id) as rank from (
      select id, text_score from scored where text_score is not null
      order by text_score desc, id
      limit ${rankDepth}
    ) top
  ),
  vector_hits as (
    select id, row_number() over (order by distance, id) as rank from (
      select id, distance from scored where distance <= ${search.maxDistance}::float8
      order by distance, id
      limit ${rankDepth}
    ) top
  ),
  best as (
    select
      scored.id,
      scored.name_match,
      text_hits.rank as text_rank,
      vector_hits.rank as vector_rank,
      (${relevance})::float8
        as relevance
      ${carry("scored")},
      row_number() over (
        order by scored.name_match desc,
          ${relevance} desc,
          scored.id
      ) as relevance_rank
    from scored
    left join text_hits on text_hits.id = scored.id
    left join vector_hits on vector_hits.id = scored.id
    where text_hits.id is not null or vector_hits.id is not null or scored.name_match
  )
  select id, name_match, text_rank, vector_rank, relevance,
    array[${sql.join([...aliases.values()], sql`, `)}]::float8[] as metrics,
    row_number() over (order by name_match desc, ${metricOrder} relevance desc, id) as position
  from best
  where relevance_rank <= ${search.limit}
  order by position
  -- The limit repeats the filter above so Postgres expects few rows and joins repos by key.
  limit ${search.limit}`;
};

export const make = Effect.fn("Db.search.make")(function* (configuredModel: EmbeddingModelId) {
  const { run } = yield* Postgres.Postgres;

  return {
    hybrid: Effect.fnUntraced(function* (search: HybridSearch) {
      const vector = search.embedding === null ? null : yield* requireModel(configuredModel, search.embedding);
      const rows = yield* run("search.hybrid", (db) => {
        const hits = db
          .$with("ranked", {
            id: sql<number>`id`.mapWith(Number).as("id"),
            nameMatch: sql<boolean>`name_match`.as("name_match"),
            textRank: sql<number | null>`text_rank`.mapWith(Number).as("text_rank"),
            vectorRank: sql<number | null>`vector_rank`.mapWith(Number).as("vector_rank"),
            score: sql<number>`relevance`.mapWith(Number).as("relevance"),
            metrics: sql<ReadonlyArray<number | null>>`metrics`.as("metrics"),
            position: sql<number>`position`.mapWith(Number).as("position"),
          })
          .as(ranked(search, vector, configuredModel));
        return db
          .with(hits)
          .select({
            repo: repoColumns,
            nameMatch: hits.nameMatch,
            textRank: hits.textRank,
            vectorRank: hits.vectorRank,
            score: hits.score,
            metrics: hits.metrics,
          })
          .from(hits)
          .innerJoin(repos, eq(repos.id, hits.id))
          .orderBy(hits.position);
      });
      return yield* decodeHits("search.hybrid")(rows);
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
