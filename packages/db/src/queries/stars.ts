import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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

const StarEvent = Schema.Struct(Struct.pick(Star.fields, ["repoId", "starredAt", "observedAt", "source"]));
export type StarEvent = typeof StarEvent.Type;

export interface StarsUpsert {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarEvent>;
}

export interface StarsSnapshot {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarredRepo>;
  readonly at: DateTime.Utc;
}

export interface SnapshotChanges {
  readonly starred: ReadonlyArray<RepoId>;
  readonly unstarred: ReadonlyArray<RepoId>;
}

export interface Queries {
  readonly upsert: (input: StarsUpsert) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly applySnapshot: (
    snapshot: StarsSnapshot,
  ) => Effect.Effect<SnapshotChanges, DbQueryFailed | DbRowInvalid | AccountNotFound>;
  readonly list: (accountId: GitHubAccountId) => Effect.Effect<ReadonlyArray<Star>, DbQueryFailed | DbRowInvalid>;
}

const decodeStars = rowsDecoder(Star);
const decodeChanged = rowsDecoder(Schema.Struct({ repoId: RepoId }));
const encodeEvents = writeEncoder(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        ...StarEvent.fields,
        starredAt: Schema.DateTimeUtcFromString,
        observedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromString);

const resultRows = (result: unknown) => (Predicate.hasProperty(result, "rows") ? result.rows : result);

const column = (target: PgColumn) => sql.identifier(target.name);

const noChanges: SnapshotChanges = { starred: [], unstarred: [] };

const writeStarsReturningVisibleChanges = (accountId: GitHubAccountId, events: string, filter: SQL) => sql`
  prior as (
    select ${column(stars.repoId)}, ${column(stars.starredAt)}, ${column(stars.unstarredAt)}
    from ${stars} where ${stars.accountId} = ${accountId}
  ),
  written as (
    insert into ${stars} (${column(stars.accountId)}, ${column(stars.repoId)}, ${column(stars.starredAt)}, ${column(stars.observedAt)}, ${column(stars.source)})
    select ${accountId}, event."repoId", event."starredAt", event."observedAt", event.source
    from (
      select distinct on ("repoId") "repoId", "starredAt", "observedAt", source
      from jsonb_to_recordset(${events}::jsonb)
        as listed("repoId" bigint, "starredAt" timestamptz, "observedAt" timestamptz, source star_source)
      order by "repoId", "observedAt" desc, "starredAt" desc, case source when 'api' then 0 else 1 end, source
    ) as event
    where ${filter}
    on conflict (${column(stars.accountId)}, ${column(stars.repoId)}) do update set
      ${column(stars.starredAt)} = ${excluded(stars.starredAt)},
      ${column(stars.source)} = ${excluded(stars.source)},
      ${column(stars.unstarredAt)} = null,
      ${column(stars.observedAt)} = ${excluded(stars.observedAt)}
    where ${excluded(stars.observedAt)} > ${stars.observedAt}
    returning ${column(stars.repoId)}, ${column(stars.starredAt)}
  )
  select written.${column(stars.repoId)}::float8 as "repoId"
  from written left join prior using (${column(stars.repoId)})
  where prior.${column(stars.repoId)} is null
    or prior.${column(stars.unstarredAt)} is not null
    or prior.${column(stars.starredAt)} <> written.${column(stars.starredAt)}`;

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;

  return {
    upsert: (input) =>
      Arr.isReadonlyArrayEmpty(input.stars)
        ? Effect.succeed([])
        : encodeEvents(input.stars).pipe(
            Effect.flatMap((events) =>
              run("stars.upsert", (db) =>
                db.execute(sql`
                  with account as (
                    select ${githubAccounts.starsFullSyncedAt} as synced from ${githubAccounts}
                    where ${githubAccounts.id} = ${input.accountId}
                    for no key update
                  ),
                  ${writeStarsReturningVisibleChanges(
                    input.accountId,
                    events,
                    sql`event."observedAt" > coalesce((select synced from account), '-infinity')`,
                  )}`),
              ),
            ),
            Effect.flatMap((result) => decodeChanged("stars.upsert")(resultRows(result))),
            Effect.map((rows) => rows.map((row) => row.repoId)),
          ),
    applySnapshot: (snapshot) =>
      Effect.all([
        encodeTime(snapshot.at),
        encodeEvents(snapshot.stars.map((star) => ({ ...star, observedAt: snapshot.at }))),
      ]).pipe(
        Effect.flatMap(([at, events]) =>
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
                return noChanges;
              }
              const starred = Arr.isReadonlyArrayNonEmpty(snapshot.stars)
                ? yield* run("stars.applySnapshot", (db) =>
                    db.execute(sql`with ${writeStarsReturningVisibleChanges(snapshot.accountId, events, sql`true`)}`),
                  ).pipe(Effect.flatMap((result) => decodeChanged("stars.applySnapshot")(resultRows(result))))
                : [];
              const unstarred = yield* run("stars.applySnapshot", (db) =>
                db
                  .update(stars)
                  .set({
                    unstarredAt: sql`coalesce(${stars.unstarredAt}, ${at}::timestamptz)`,
                    observedAt: sql`${at}::timestamptz`,
                  })
                  .where(and(eq(stars.accountId, snapshot.accountId), sql`${stars.observedAt} < ${at}::timestamptz`))
                  .returning({
                    repoId: stars.repoId,
                    newlyUnstarred: sql<boolean>`${stars.unstarredAt} = ${at}::timestamptz`,
                  }),
              );
              const newlyUnstarred = yield* decodeChanged("stars.applySnapshot")(
                unstarred.filter((row) => row.newlyUnstarred),
              );
              return {
                starred: starred.map((row) => row.repoId),
                unstarred: newlyUnstarred.map((row) => row.repoId),
              };
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
