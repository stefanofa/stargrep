import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, eq, isNull, ne, notExists, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EmbeddingModelId } from "../embedding.ts";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder } from "../rows.ts";
import { repoMetrics, repos, similarCandidate, similarCandidates, stars } from "../schema.ts";
import { Repo, repoColumns } from "./repos.ts";

export interface SimilarQuery {
  readonly accountId: GitHubAccountId;
  readonly repoId: RepoId;
  readonly limit: number;
}

const SimilarRepo = Schema.Struct({
  repo: Repo,
  stars: Schema.NullOr(Schema.Int),
  distance: Schema.Finite,
});
export type SimilarRepo = Omit<typeof SimilarRepo.Type, "distance">;

export interface Queries {
  // The account's current stars nearest the repo by embedding, nearest first, the repo itself left out. An exact scan of
  // the account's stars, as search makes, so it needs no vector index. None when the repo has no embedding.
  readonly inStars: (query: SimilarQuery) => Effect.Effect<ReadonlyArray<SimilarRepo>, DbQueryFailed | DbRowInvalid>;
  // The repos with a summary nearest the repo across stargrep that the account doesn't star now, nearest first, through
  // the HNSW index on similar_candidates. Gone and archived repos are left out. None when the repo has no embedding.
  readonly notStarred: (query: SimilarQuery) => Effect.Effect<ReadonlyArray<SimilarRepo>, DbQueryFailed | DbRowInvalid>;
}

const decode = rowsDecoder(SimilarRepo);

// An iterative scan returns its matches in about the order of distance, so the nearest come back sorted here.
const nearestFirst = (rows: ReadonlyArray<typeof SimilarRepo.Type>): ReadonlyArray<SimilarRepo> =>
  [...rows].sort((a, b) => a.distance - b.distance).map(({ repo, stars }) => ({ repo, stars }));

export const make = Effect.fn("Db.similar.make")(function* (configuredModel: EmbeddingModelId) {
  const { run, withTransaction } = yield* Postgres.Postgres;
  // Only a vector from the configured model compares with the others.
  const source = (repoId: RepoId) =>
    sql`(select ${repos.embedding} from ${repos} where ${repos.id} = ${repoId} and ${repos.embeddingModel} = ${configuredModel})`;
  const fields = (repoId: RepoId) => ({
    repo: repoColumns,
    stars: repoMetrics.stars,
    distance: sql<number>`(${repos.embedding} <=> ${source(repoId)})::float8`,
  });

  return {
    inStars: ({ accountId, repoId, limit }) =>
      run("similar.inStars", (db) =>
        db
          .select(fields(repoId))
          .from(stars)
          .innerJoin(repos, eq(repos.id, stars.repoId))
          .leftJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
          .where(
            and(
              eq(stars.accountId, accountId),
              isNull(stars.unstarredAt),
              ne(repos.id, repoId),
              eq(repos.embeddingModel, configuredModel),
              isNull(repos.goneAt),
              sql`${source(repoId)} is not null`,
            ),
          )
          .orderBy(sql`${repos.embedding} <=> ${source(repoId)}`)
          .limit(limit),
      ).pipe(Effect.flatMap(decode("similar.inStars")), Effect.map(nearestFirst)),

    // Without an iterative scan, the index hands over its nearest 40 and the account's own stars among them are dropped
    // after, which can leave none for an account that starred the whole neighborhood.
    notStarred: ({ accountId, repoId, limit }) =>
      withTransaction(
        Effect.andThen(
          run("similar.notStarred", (db) => db.execute(sql`set local hnsw.iterative_scan = relaxed_order`)),
          run("similar.notStarred", (db) =>
            db
              .select({
                ...fields(repoId),
                distance: sql<number>`(${similarCandidates.embedding} <=> ${source(repoId)})::float8`,
              })
              .from(similarCandidates)
              .innerJoin(repos, eq(repos.id, similarCandidates.repoId))
              .leftJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
              .where(
                and(
                  ne(similarCandidates.repoId, repoId),
                  // The triggers keep the table to these repos. Checking the row as well keeps out one a backfill
                  // copied just as it stopped being one.
                  similarCandidate(repos),
                  eq(repos.embeddingModel, configuredModel),
                  sql`${source(repoId)} is not null`,
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(stars)
                      .where(
                        and(
                          eq(stars.accountId, accountId),
                          eq(stars.repoId, similarCandidates.repoId),
                          isNull(stars.unstarredAt),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(sql`${similarCandidates.embedding} <=> ${source(repoId)}`)
              .limit(limit),
          ),
        ),
      ).pipe(Effect.flatMap(decode("similar.notStarred")), Effect.map(nearestFirst)),
  } satisfies Queries;
});
