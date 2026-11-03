import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import { GitHubAccountId, RepoId } from "../ids.ts";
import * as Memory from "../memory.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, rowsDecoder } from "../rows.ts";
import { stars } from "../schema.ts";

export const Star = createSelectSchema(stars, {
  accountId: GitHubAccountId,
  repoId: RepoId,
  starredAt: Schema.DateTimeUtcFromDate,
  unstarredAt: NullableTime,
});
export type Star = typeof Star.Type;

export type StarredRepo = Pick<Star, "repoId" | "starredAt" | "source">;

export interface StarsUpsert {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarredRepo>;
}

export interface Unstar {
  readonly accountId: GitHubAccountId;
  readonly keep: ReadonlyArray<RepoId>;
  readonly at: DateTime.Utc;
}

export interface Queries {
  readonly upsert: (input: StarsUpsert) => Effect.Effect<void, DbQueryFailed>;
  readonly markUnstarred: (input: Unstar) => Effect.Effect<number, DbQueryFailed>;
  readonly list: (accountId: GitHubAccountId) => Effect.Effect<ReadonlyArray<Star>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeStars = rowsDecoder(Star);

export const postgres = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    upsert: (input) =>
      Effect.forEach(
        Arr.chunksOf(input.stars, batchSize),
        (chunk) =>
          run("stars.upsert", (db) =>
            db
              .insert(stars)
              .values(
                chunk.map((star) => ({
                  accountId: input.accountId,
                  repoId: star.repoId,
                  starredAt: DateTime.toDateUtc(star.starredAt),
                  source: star.source,
                })),
              )
              .onConflictDoUpdate({
                target: [stars.accountId, stars.repoId],
                set: {
                  starredAt: sql.raw(`excluded."starred_at"`),
                  source: sql.raw(`excluded."source"`),
                  unstarredAt: null,
                },
                setWhere: sql`excluded."starred_at" > ${stars.starredAt} and (${stars.unstarredAt} is null or excluded."starred_at" > ${stars.unstarredAt})`,
              }),
          ),
        { discard: true },
      ),
    markUnstarred: (input) =>
      run("stars.markUnstarred", (db) =>
        db
          .update(stars)
          .set({ unstarredAt: DateTime.toDateUtc(input.at) })
          .where(
            and(
              eq(stars.accountId, input.accountId),
              isNull(stars.unstarredAt),
              sql`${stars.repoId} <> all(${sql.param([...input.keep])}::bigint[])`,
            ),
          )
          .returning({ repoId: stars.repoId }),
      ).pipe(Effect.map((rows) => rows.length)),
    list: (accountId) =>
      run("stars.list", (db) =>
        db
          .select()
          .from(stars)
          .where(and(eq(stars.accountId, accountId), isNull(stars.unstarredAt)))
          .orderBy(desc(stars.starredAt), stars.repoId),
      ).pipe(Effect.flatMap(decodeStars("stars.list"))),
  } satisfies Queries;
});

const isNewer = (incoming: DateTime.Utc, current: DateTime.Utc | null) =>
  current === null || DateTime.isGreaterThan(incoming, current);

const newestFirst = Order.combine(
  Order.mapInput(Order.flip(DateTime.Order), (star: Star) => star.starredAt),
  Order.mapInput(Order.Number, (star: Star) => star.repoId),
);

export const memory = Effect.gen(function* () {
  const { tables } = yield* Memory.MemoryStore;

  const active = (accountId: GitHubAccountId) =>
    Array.from(tables.stars.values()).filter((star) => star.accountId === accountId && star.unstarredAt === null);

  return {
    upsert: (input) =>
      Effect.suspend(() => {
        if (!tables.accounts.has(input.accountId) || input.stars.some((star) => !tables.repos.has(star.repoId))) {
          return Effect.fail(new DbQueryFailed({ operation: "stars.upsert", reason: "constraint", sqlState: "23503" }));
        }
        for (const star of input.stars) {
          const key = Memory.starKey(input.accountId, star.repoId);
          const current = tables.stars.get(key);
          if (
            current === undefined ||
            (isNewer(star.starredAt, current.starredAt) && isNewer(star.starredAt, current.unstarredAt))
          ) {
            tables.stars.set(key, { accountId: input.accountId, ...star, unstarredAt: null });
          }
        }
        return Effect.void;
      }),
    markUnstarred: (input) =>
      Effect.sync(() => {
        const keep = new Set<number>(input.keep);
        const gone = active(input.accountId).filter((star) => !keep.has(star.repoId));
        for (const star of gone) {
          tables.stars.set(Memory.starKey(star.accountId, star.repoId), { ...star, unstarredAt: input.at });
        }
        return gone.length;
      }),
    list: (accountId) => Effect.sync(() => Arr.sort(active(accountId), newestFirst)),
  } satisfies Queries;
});
