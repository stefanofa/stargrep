import type { GitHubAccountId } from "@stargrep/github/schemas";
import { desc, eq, type SQL, sql } from "drizzle-orm";
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
import { rowsDecoder } from "../rows.ts";
import { repos, stars } from "../schema.ts";
import { Repo, repoColumns } from "./repos.ts";

const SearchHit = Schema.Struct({
  repo: Repo,
  textRank: Schema.NullOr(Schema.Int),
  vectorRank: Schema.NullOr(Schema.Int),
  score: Schema.Finite,
});
export type SearchHit = typeof SearchHit.Type;

export interface SearchScope {
  readonly kind: "stars";
  readonly accountId: GitHubAccountId;
}

export interface HybridSearch {
  readonly scope: SearchScope;
  readonly text: string;
  readonly embedding: Embedding;
  readonly limit: number;
}

export interface Queries {
  readonly hybrid: (
    search: HybridSearch,
  ) => Effect.Effect<ReadonlyArray<SearchHit>, DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch>;
}

const rankDepth = sql.raw("100");
const fusionK = sql.raw("60");
const decodeHits = rowsDecoder(SearchHit);

const candidates = (scope: SearchScope): SQL =>
  sql`select ${stars.repoId} from ${stars} where ${stars.accountId} = ${scope.accountId} and ${stars.unstarredAt} is null`;

const fused = (source: SQL, text: string, vector: EmbeddingVector, model: EmbeddingModelId) => sql`
  with scored as materialized (
    select
      ${repos.id} as id,
      case when ${repos.search} @@ query then ts_rank_cd(${repos.search}, query) end as text_score,
      case when ${repos.embeddingModel} = ${model}
        then ${repos.embedding} <=> ${`[${vector.join(",")}]`}::halfvec end as distance
    from ${repos}, websearch_to_tsquery('english', ${text}) query
    where ${repos.id} in (${source})
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
      select id, distance from scored where distance is not null
      order by distance, id
      limit ${rankDepth}
    ) top
  )
  select
    coalesce(t.id, v.id) as id,
    t.rank as text_rank,
    v.rank as vector_rank,
    (coalesce(1.0 / (${fusionK} + t.rank), 0) + coalesce(1.0 / (${fusionK} + v.rank), 0))::float8 as score
  from text_hits t full outer join vector_hits v on v.id = t.id`;

export const make = Effect.fn("Db.search.make")(function* (configuredModel: EmbeddingModelId) {
  const { run } = yield* Postgres.Postgres;

  return {
    hybrid: (search) =>
      requireModel(configuredModel, search.embedding).pipe(
        Effect.flatMap((vector) =>
          run("search.hybrid", (db) => {
            const ranked = db
              .$with("ranked", {
                id: sql<number>`id`.mapWith(Number).as("id"),
                textRank: sql<number | null>`text_rank`.mapWith(Number).as("text_rank"),
                vectorRank: sql<number | null>`vector_rank`.mapWith(Number).as("vector_rank"),
                score: sql<number>`score`.mapWith(Number).as("score"),
              })
              .as(fused(candidates(search.scope), search.text, vector, configuredModel));
            return db
              .with(ranked)
              .select({
                repo: repoColumns,
                textRank: ranked.textRank,
                vectorRank: ranked.vectorRank,
                score: ranked.score,
              })
              .from(ranked)
              .innerJoin(repos, eq(repos.id, ranked.id))
              .orderBy(desc(ranked.score), repos.id)
              .limit(search.limit);
          }),
        ),
        Effect.flatMap(decodeHits("search.hybrid")),
      ),
  } satisfies Queries;
});
