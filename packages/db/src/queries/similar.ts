import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, eq, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EmbeddingModelId } from "../embedding.ts";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { resultRows, rowsDecoder } from "../rows.ts";
import { repoMetrics, repos, similarCandidate, similarCandidates, stars } from "../schema.ts";
import { type Suspect, suspects, withoutCopies } from "./near-copies.ts";
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
type Found = typeof SimilarRepo.Type;
export type SimilarRepo = Omit<Found, "distance">;

export interface SimilarRows {
  // The account's current stars nearest the repo by embedding, nearest first, the repo itself left out.
  readonly inStars: ReadonlyArray<SimilarRepo>;
  // The repos with a summary nearest the repo across stargrep that the account doesn't star now, nearest first. Gone
  // and archived repos are left out.
  readonly notStarred: ReadonlyArray<SimilarRepo>;
}

export interface Queries {
  // Both rows of repos near the repo, `limit` each, leaving out copies such as forks and mirrors (near-copies.ts). The
  // first scans the account's stars exactly, as search does, and the second reads the HNSW index on
  // similar_candidates. Both are empty when the repo has no embedding of the configured model.
  readonly near: (query: SimilarQuery) => Effect.Effect<SimilarRows, DbQueryFailed | DbRowInvalid>;
}

// How many repos each row reads before copies are left out. On a branch of prod, the copies among the 30 nearest of the
// 300 most starred repos left 5 others for every one of them.
const nearest = 30;

const decode = rowsDecoder(SimilarRepo);
const decodeApart = rowsDecoder(
  Schema.Struct({ copy: Schema.Finite, original: Schema.Finite, distance: Schema.Finite }),
);

// An iterative scan returns its matches in about the order of distance, so the nearest come back sorted here.
const nearestFirst = (rows: ReadonlyArray<Found>): ReadonlyArray<Found> =>
  [...rows].sort((a, b) => a.distance - b.distance);

const shown = (rows: ReadonlyArray<Found>): ReadonlyArray<SimilarRepo> =>
  rows.map(({ repo, stars }) => ({ repo, stars }));

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

  const opened = (repoId: RepoId) =>
    run("similar.opened", (db) =>
      db
        .select(fields(repoId))
        .from(repos)
        .leftJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
        .where(and(eq(repos.id, repoId), eq(repos.embeddingModel, configuredModel), isNotNull(repos.embedding))),
    ).pipe(Effect.flatMap(decode("similar.opened")));

  // Ranks the account's stars by distance alone, then reads the columns and metrics of the nearest, so the sort carries
  // two columns per star rather than whole rows.
  const inStars = ({ accountId, repoId }: SimilarQuery) =>
    run("similar.inStars", (db) => {
      const ranked = db
        .select({ id: repos.id, distance: sql<number>`${repos.embedding} <=> ${source(repoId)}`.as("distance") })
        .from(stars)
        .innerJoin(repos, eq(repos.id, stars.repoId))
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
        .orderBy(sql`distance`)
        .limit(nearest)
        .as("ranked");
      return db
        .select({ repo: repoColumns, stars: repoMetrics.stars, distance: sql<number>`${ranked.distance}::float8` })
        .from(ranked)
        .innerJoin(repos, eq(repos.id, ranked.id))
        .leftJoin(repoMetrics, eq(repoMetrics.repoId, ranked.id))
        .orderBy(ranked.distance);
    }).pipe(Effect.flatMap(decode("similar.inStars")), Effect.map(nearestFirst));

  // Without an iterative scan, the index hands over its nearest 40 and the account's own stars among them are dropped
  // after, which can leave none for an account that starred the whole neighborhood.
  const notStarred = ({ accountId, repoId }: SimilarQuery) =>
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
            .limit(nearest),
        ),
      ),
    ).pipe(Effect.flatMap(decode("similar.notStarred")), Effect.map(nearestFirst));

  // How far each suspected copy sits from its original.
  const apart = (pairs: ReadonlyArray<Suspect>) =>
    pairs.length === 0
      ? Effect.succeed([])
      : run("similar.apart", (db) =>
          db.execute(sql`
            select pair.copy_id::float8 as copy, pair.original_id::float8 as original,
              (c.embedding <=> o.embedding)::float8 as distance
            from unnest(${sql.param(pairs.map((pair) => pair.copy))}::bigint[],
              ${sql.param(pairs.map((pair) => pair.original))}::bigint[]) as pair (copy_id, original_id)
            join ${repos} as c on c.id = pair.copy_id
            join ${repos} as o on o.id = pair.original_id`),
        ).pipe(
          Effect.flatMap((result) => decodeApart("similar.apart")(resultRows(result))),
          Effect.map((rows) =>
            rows.flatMap((row) =>
              pairs
                .filter((pair) => pair.copy === row.copy && pair.original === row.original)
                .map((pair) => ({ ...pair, distance: row.distance })),
            ),
          ),
        );

  return {
    near: Effect.fn("Db.similar.near")(function* (query: SimilarQuery) {
      const [source] = yield* opened(query.repoId);
      if (source === undefined) return { inStars: [], notStarred: [] };
      const own = yield* inStars(query);
      const others = yield* notStarred(query);
      // The account's stars are references for the other row, so the forks of a repo it starred stay out of it too.
      const pairs = [...suspects(own, []), ...suspects(others, own)];
      const distances = yield* apart(pairs);
      return {
        inStars: shown(withoutCopies(source, own, distances, query.limit)),
        notStarred: shown(withoutCopies(source, others, distances, query.limit)),
      };
    }),
  } satisfies Queries;
});
