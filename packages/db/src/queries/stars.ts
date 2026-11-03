import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, rowsDecoder, writeEncoder } from "../rows.ts";
import { githubAccounts, stars } from "../schema.ts";

export const Star = createSelectSchema(stars, {
  accountId: GitHubAccountId,
  repoId: RepoId,
  starredAt: Schema.DateTimeUtcFromDate,
  unstarredAt: NullableTime,
  observedAt: Schema.DateTimeUtcFromDate,
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
  readonly upsert: (input: StarsUpsert) => Effect.Effect<void, DbQueryFailed | DbRowInvalid>;
  readonly markUnstarred: (input: Unstar) => Effect.Effect<number, DbQueryFailed | AccountNotFound>;
  readonly list: (accountId: GitHubAccountId) => Effect.Effect<ReadonlyArray<Star>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeStars = rowsDecoder(Star);
const decodeSnapshot = rowsDecoder(Schema.Struct({ at: NullableTime }));
const encodeStars = writeEncoder(Schema.Array(Star));
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;

  const lastSnapshot = (accountId: GitHubAccountId) =>
    run("stars.upsert", (db) =>
      db.select({ at: githubAccounts.starsFullSyncedAt }).from(githubAccounts).where(eq(githubAccounts.id, accountId)),
    ).pipe(
      Effect.flatMap(decodeSnapshot("stars.upsert")),
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.at)),
    );

  const insert = (accountId: GitHubAccountId, chunk: ReadonlyArray<StarredRepo>) =>
    encodeStars(chunk.map((star) => ({ ...star, accountId, unstarredAt: null, observedAt: star.starredAt }))).pipe(
      Effect.flatMap((values) =>
        run("stars.upsert", (db) =>
          db
            .insert(stars)
            .values([...values])
            .onConflictDoUpdate({
              target: [stars.accountId, stars.repoId],
              set: {
                starredAt: excluded(stars.starredAt),
                source: excluded(stars.source),
                unstarredAt: null,
                observedAt: excluded(stars.observedAt),
              },
              setWhere: sql`${excluded(stars.observedAt)} > ${stars.observedAt}`,
            }),
        ),
      ),
    );

  return {
    upsert: (input) =>
      Arr.isReadonlyArrayEmpty(input.stars)
        ? Effect.void
        : withTransaction(
            Effect.gen(function* () {
              const snapshot = yield* lastSnapshot(input.accountId);
              const newer = input.stars.filter((star) =>
                Option.match(snapshot, {
                  onNone: () => true,
                  onSome: (at) => DateTime.isGreaterThan(star.starredAt, at),
                }),
              );
              yield* Effect.forEach(Arr.chunksOf(newer, batchSize), (chunk) => insert(input.accountId, chunk), {
                discard: true,
              });
            }),
          ),
    markUnstarred: (input) =>
      encodeTime(input.at).pipe(
        Effect.flatMap((at) =>
          withTransaction(
            Effect.gen(function* () {
              const advanced = yield* run("stars.markUnstarred", (db) =>
                db
                  .update(githubAccounts)
                  .set({ starsFullSyncedAt: at })
                  .where(
                    and(
                      eq(githubAccounts.id, input.accountId),
                      sql`(${githubAccounts.starsFullSyncedAt} is null or ${githubAccounts.starsFullSyncedAt} < ${at})`,
                    ),
                  )
                  .returning({ id: githubAccounts.id }),
              );
              if (Arr.isReadonlyArrayNonEmpty(advanced)) {
                const marked = yield* run("stars.markUnstarred", (db) =>
                  db
                    .update(stars)
                    .set({ unstarredAt: sql`coalesce(${stars.unstarredAt}, ${at})`, observedAt: at })
                    .where(
                      and(
                        eq(stars.accountId, input.accountId),
                        sql`${stars.observedAt} < ${at}`,
                        sql`${stars.repoId} <> all(${sql.param([...input.keep])}::bigint[])`,
                      ),
                    )
                    .returning({ newlyUnstarred: sql<boolean>`${stars.unstarredAt} = ${at}` }),
                );
                return marked.filter((row) => row.newlyUnstarred).length;
              }
              const account = yield* run("stars.markUnstarred", (db) =>
                db.select({ id: githubAccounts.id }).from(githubAccounts).where(eq(githubAccounts.id, input.accountId)),
              );
              return Arr.isReadonlyArrayNonEmpty(account)
                ? 0
                : yield* new AccountNotFound({ accountId: input.accountId });
            }),
          ),
        ),
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
