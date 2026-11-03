import { and, cosineDistance, desc, eq, isNull, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Embedding, type EmbeddingVector, requireModel } from "../embedding.ts";
import type { DbQueryFailed, DbRowInvalid, EmbeddingModelMismatch } from "../errors.ts";
import type { EmbeddingModel, GitHubAccountId, RepoId } from "../ids.ts";
import * as Memory from "../memory.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder } from "../rows.ts";
import { repos, stars } from "../schema.ts";
import { Repo, repoColumns, type StoredRepo } from "./repos.ts";

const NearestStar = Schema.Struct({ repo: Repo, distance: Schema.Finite });
export type NearestStar = typeof NearestStar.Type;

const HybridHit = Schema.Struct({
  repo: Repo,
  textRank: Schema.NullOr(Schema.Int),
  vectorRank: Schema.NullOr(Schema.Int),
  score: Schema.Finite,
});
export type HybridHit = typeof HybridHit.Type;

export interface VectorSearch {
  readonly accountId: GitHubAccountId;
  readonly embedding: Embedding;
  readonly limit: number;
}

export interface HybridSearch extends VectorSearch {
  readonly text: string;
}

type SearchError = DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch;

export interface Queries {
  readonly nearestStars: (search: VectorSearch) => Effect.Effect<ReadonlyArray<NearestStar>, SearchError>;
  readonly hybridStars: (search: HybridSearch) => Effect.Effect<ReadonlyArray<HybridHit>, SearchError>;
}

const rankDepth = 100;
const fusionK = 60;
const decodeNearest = rowsDecoder(NearestStar);
const decodeHybrid = rowsDecoder(HybridHit);

const fused = (search: HybridSearch, vector: EmbeddingVector) => sql`
  with scored as materialized (
    select
      r.id,
      case when r.search @@ query then ts_rank_cd(r.search, query) end as text_score,
      case when r.embedding_model = ${search.embedding.model} then r.embedding <=> ${`[${vector.join(",")}]`}::halfvec end as distance
    from stars s join repos r on r.id = s.repo_id, websearch_to_tsquery('english', ${search.text}) query
    where s.account_id = ${search.accountId} and s.unstarred_at is null
  ),
  text_hits as (
    select id, row_number() over (order by text_score desc, id) as rank from (
      select id, text_score from scored where text_score is not null
      order by text_score desc, id
      limit ${sql.raw(String(rankDepth))}
    ) top
  ),
  vector_hits as (
    select id, row_number() over (order by distance, id) as rank from (
      select id, distance from scored where distance is not null
      order by distance, id
      limit ${sql.raw(String(rankDepth))}
    ) top
  )
  select
    coalesce(t.id, v.id) as id,
    t.rank as text_rank,
    v.rank as vector_rank,
    (coalesce(1.0 / (${sql.raw(String(fusionK))} + t.rank), 0) + coalesce(1.0 / (${sql.raw(String(fusionK))} + v.rank), 0))::float8 as score
  from text_hits t full outer join vector_hits v on v.id = t.id`;

export const postgres = Effect.fn("Db.search.postgres")(function* (configuredModel: EmbeddingModel) {
  const { run } = yield* Postgres.Postgres;

  return {
    nearestStars: (search) =>
      requireModel(configuredModel, search.embedding).pipe(
        Effect.flatMap((vector) =>
          run("search.nearestStars", (db) => {
            const distance = cosineDistance(repos.embedding, [...vector]).as("distance");
            return db
              .select({ repo: repoColumns, distance })
              .from(stars)
              .innerJoin(repos, eq(repos.id, stars.repoId))
              .where(
                and(
                  eq(stars.accountId, search.accountId),
                  isNull(stars.unstarredAt),
                  eq(repos.embeddingModel, configuredModel),
                ),
              )
              .orderBy(sql`distance`, repos.id)
              .limit(search.limit);
          }),
        ),
        Effect.flatMap(decodeNearest("search.nearestStars")),
      ),
    hybridStars: (search) =>
      requireModel(configuredModel, search.embedding).pipe(
        Effect.flatMap((vector) =>
          run("search.hybridStars", (db) => {
            const ranked = db
              .$with("ranked", {
                id: sql<number>`id`.mapWith(Number).as("id"),
                textRank: sql<number | null>`text_rank`.mapWith(Number).as("text_rank"),
                vectorRank: sql<number | null>`vector_rank`.mapWith(Number).as("vector_rank"),
                score: sql<number>`score`.mapWith(Number).as("score"),
              })
              .as(fused(search, vector));
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
        Effect.flatMap(decodeHybrid("search.hybridStars")),
      ),
  } satisfies Queries;
});

const words = (text: string | null) => (text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const textScore = (repo: StoredRepo, query: ReadonlyArray<string>) => {
  const document = [repo.owner, repo.name, repo.description, ...repo.topics, ...repo.keywords, repo.summary].flatMap(
    words,
  );
  return query.every((word) => document.includes(word)) ? document.filter((word) => query.includes(word)).length : 0;
};

const cosineDistanceOf = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return 1 - dot / Math.sqrt(normA * normB);
};

const withoutEmbedding = ({ embedding: _, ...repo }: StoredRepo): Repo => repo;

const ranks = <A>(items: ReadonlyArray<A>, id: (item: A) => RepoId) =>
  new Map(items.slice(0, rankDepth).map((item, index) => [id(item), index + 1]));

export const memory = Effect.fn("Db.search.memory")(function* (configuredModel: EmbeddingModel) {
  const { tables } = yield* Memory.MemoryStore;

  const candidates = (accountId: GitHubAccountId) =>
    Array.from(tables.stars.values()).flatMap((star) => {
      const repo =
        star.accountId === accountId && star.unstarredAt === null ? tables.repos.get(star.repoId) : undefined;
      return repo === undefined ? [] : [repo];
    });

  const nearest = (accountId: GitHubAccountId, vector: EmbeddingVector) =>
    candidates(accountId)
      .flatMap((repo) =>
        repo.embedding !== null && repo.embeddingModel === configuredModel
          ? [{ repo, distance: cosineDistanceOf(repo.embedding, vector) }]
          : [],
      )
      .sort((a, b) => a.distance - b.distance || a.repo.id - b.repo.id);

  return {
    nearestStars: (search) =>
      requireModel(configuredModel, search.embedding).pipe(
        Effect.map((vector) =>
          nearest(search.accountId, vector)
            .slice(0, search.limit)
            .map(({ repo, distance }) => ({ repo: withoutEmbedding(repo), distance })),
        ),
      ),
    hybridStars: (search) =>
      requireModel(configuredModel, search.embedding).pipe(
        Effect.map((vector) => {
          const query = words(search.text);
          const textHits = candidates(search.accountId)
            .map((repo) => ({ repo, score: query.length === 0 ? 0 : textScore(repo, query) }))
            .filter((hit) => hit.score > 0)
            .sort((a, b) => b.score - a.score || a.repo.id - b.repo.id);
          const textRanks = ranks(textHits, (hit) => hit.repo.id);
          const vectorRanks = ranks(nearest(search.accountId, vector), (hit) => hit.repo.id);
          const fusion = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (fusionK + rank));
          return Arr.dedupe([...textRanks.keys(), ...vectorRanks.keys()])
            .flatMap((id) => {
              const repo = tables.repos.get(id);
              if (repo === undefined) return [];
              const textRank = textRanks.get(id) ?? null;
              const vectorRank = vectorRanks.get(id) ?? null;
              return [
                {
                  repo: withoutEmbedding(repo),
                  textRank,
                  vectorRank,
                  score: fusion(textRanks.get(id)) + fusion(vectorRanks.get(id)),
                },
              ];
            })
            .sort((a, b) => b.score - a.score || a.repo.id - b.repo.id)
            .slice(0, search.limit);
        }),
      ),
  } satisfies Queries;
});
