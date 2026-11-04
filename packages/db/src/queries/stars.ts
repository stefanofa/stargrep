import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, requireRow, rowsDecoder, writeEncoder } from "../rows.ts";
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

export interface StarsSnapshot {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarredRepo>;
  readonly at: DateTime.Utc;
}

export interface Queries {
  readonly upsert: (input: StarsUpsert) => Effect.Effect<void, DbQueryFailed>;
  readonly applySnapshot: (snapshot: StarsSnapshot) => Effect.Effect<number, DbQueryFailed | AccountNotFound>;
  readonly list: (accountId: GitHubAccountId) => Effect.Effect<ReadonlyArray<Star>, DbQueryFailed | DbRowInvalid>;
}

const decodeStars = rowsDecoder(Star);
const encodeStarred = writeEncoder(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ ...StarredRepo.fields, starredAt: Schema.DateTimeUtcFromString })),
  ),
);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromString);

const column = (target: PgColumn) => sql.identifier(target.name);

const insertStars = (accountId: GitHubAccountId, starred: string, observedAt: SQL, filter: SQL) => sql`
  insert into ${stars} (${column(stars.accountId)}, ${column(stars.repoId)}, ${column(stars.starredAt)}, ${column(stars.observedAt)}, ${column(stars.source)})
  select ${accountId}, starred."repoId", starred."starredAt", ${observedAt}, starred.source
  from (
    select distinct on ("repoId") "repoId", "starredAt", source
    from jsonb_to_recordset(${starred}::jsonb) as listed("repoId" bigint, "starredAt" timestamptz, source star_source)
    order by "repoId", "starredAt" desc, case source when 'api' then 0 else 1 end, source
  ) as starred
  where ${filter}
  on conflict (${column(stars.accountId)}, ${column(stars.repoId)}) do update set
    ${column(stars.starredAt)} = ${excluded(stars.starredAt)},
    ${column(stars.source)} = ${excluded(stars.source)},
    ${column(stars.unstarredAt)} = null,
    ${column(stars.observedAt)} = ${excluded(stars.observedAt)}
  where ${excluded(stars.observedAt)} > ${stars.observedAt}`;

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;

  return {
    upsert: (input) =>
      Arr.isReadonlyArrayEmpty(input.stars)
        ? Effect.void
        : encodeStarred(input.stars).pipe(
            Effect.flatMap((starred) =>
              run("stars.upsert", (db) =>
                db.execute(sql`
                  with account as (
                    select ${githubAccounts.starsFullSyncedAt} as synced from ${githubAccounts}
                    where ${githubAccounts.id} = ${input.accountId}
                    for no key update
                  )
                  ${insertStars(
                    input.accountId,
                    starred,
                    sql`starred."starredAt"`,
                    sql`starred."starredAt" > coalesce((select synced from account), '-infinity')`,
                  )}`),
              ),
            ),
            Effect.asVoid,
          ),
    applySnapshot: (snapshot) =>
      Effect.all([encodeTime(snapshot.at), encodeStarred(snapshot.stars)]).pipe(
        Effect.flatMap(([at, starred]) =>
          withTransaction(
            Effect.gen(function* () {
              const advanced = yield* run("stars.applySnapshot", (db) =>
                db
                  .update(githubAccounts)
                  .set({ starsFullSyncedAt: sql`${at}::timestamptz` })
                  .where(
                    and(
                      eq(githubAccounts.id, snapshot.accountId),
                      sql`(${githubAccounts.starsFullSyncedAt} is null or ${githubAccounts.starsFullSyncedAt} < ${at}::timestamptz)`,
                    ),
                  )
                  .returning({ id: githubAccounts.id }),
              );
              if (Arr.isReadonlyArrayEmpty(advanced)) {
                yield* run("stars.applySnapshot", (db) =>
                  db
                    .select({ id: githubAccounts.id })
                    .from(githubAccounts)
                    .where(eq(githubAccounts.id, snapshot.accountId)),
                ).pipe(Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: snapshot.accountId }))));
                return 0;
              }
              if (Arr.isReadonlyArrayNonEmpty(snapshot.stars)) {
                yield* run("stars.applySnapshot", (db) =>
                  db.execute(insertStars(snapshot.accountId, starred, sql`${at}::timestamptz`, sql`true`)),
                );
              }
              const unstarred = yield* run("stars.applySnapshot", (db) =>
                db
                  .update(stars)
                  .set({
                    unstarredAt: sql`coalesce(${stars.unstarredAt}, ${at}::timestamptz)`,
                    observedAt: sql`${at}::timestamptz`,
                  })
                  .where(and(eq(stars.accountId, snapshot.accountId), sql`${stars.observedAt} < ${at}::timestamptz`))
                  .returning({ newlyUnstarred: sql<boolean>`${stars.unstarredAt} = ${at}::timestamptz` }),
              );
              return unstarred.filter((row) => row.newlyUnstarred).length;
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
