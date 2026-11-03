import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, rowsDecoder, writeEncoder } from "../rows.ts";
import { stars } from "../schema.ts";

export const Star = createSelectSchema(stars, {
  accountId: GitHubAccountId,
  repoId: RepoId,
  starredAt: Schema.DateTimeUtcFromDate,
  unstarredAt: NullableTime,
});
export type Star = typeof Star.Type;

const StarredRepo = Schema.Struct(Struct.pick(Star.fields, ["repoId", "starredAt", "source"]));
export type StarredRepo = typeof StarredRepo.Type;

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
const encodeStars = writeEncoder(Schema.Array(Star));
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;

  return {
    upsert: (input) =>
      withTransaction(
        Effect.forEach(
          Arr.chunksOf(input.stars, batchSize),
          (chunk) =>
            encodeStars(chunk.map((star) => ({ ...star, accountId: input.accountId, unstarredAt: null }))).pipe(
              Effect.flatMap((values) =>
                run("stars.upsert", (db) =>
                  db
                    .insert(stars)
                    .values([...values])
                    .onConflictDoUpdate({
                      target: [stars.accountId, stars.repoId],
                      set: { starredAt: excluded(stars.starredAt), source: excluded(stars.source), unstarredAt: null },
                      setWhere: sql`${excluded(stars.starredAt)} > ${stars.starredAt} and (${stars.unstarredAt} is null or ${excluded(stars.starredAt)} > ${stars.unstarredAt})`,
                    }),
                ),
              ),
            ),
          { discard: true },
        ),
      ),
    markUnstarred: (input) =>
      encodeTime(input.at).pipe(
        Effect.flatMap((at) =>
          run("stars.markUnstarred", (db) =>
            db
              .update(stars)
              .set({ unstarredAt: at })
              .where(
                and(
                  eq(stars.accountId, input.accountId),
                  isNull(stars.unstarredAt),
                  sql`${stars.repoId} <> all(${sql.param([...input.keep])}::bigint[])`,
                ),
              )
              .returning({ repoId: stars.repoId }),
          ),
        ),
        Effect.map((rows) => rows.length),
      ),
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
