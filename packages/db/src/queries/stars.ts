import { GitHubAccountId, type Login, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, gt, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, requireRow, rowsDecoder, writeEncoder } from "../rows.ts";
import { enrichFailureCap, githubAccounts, repoMetrics, repos, stars, unreadEnrichment } from "../schema.ts";
import { accountNamed } from "./accounts.ts";
import { Repo, repoColumns } from "./repos.ts";

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

const LibraryEntry = Schema.Struct({
  repo: Repo,
  starredAt: Schema.DateTimeUtcFromDate,
  stars: Schema.NullOr(Schema.Int),
  read: Schema.Boolean,
});
export type LibraryEntry = typeof LibraryEntry.Type;

const EnrichmentProgress = Schema.Struct({ total: Schema.Int, read: Schema.Int, failed: Schema.Int });
export type EnrichmentProgress = typeof EnrichmentProgress.Type;

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

export interface StarsPosition {
  readonly starredAt: DateTime.Utc;
  readonly repoId: RepoId;
}

export interface StarsPage {
  readonly entries: ReadonlyArray<LibraryEntry>;
  // Where the next page starts, or none when this page is the last.
  readonly next: Option.Option<StarsPosition>;
}

export interface Queries {
  readonly upsert: (input: StarsUpsert) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly applySnapshot: (
    snapshot: StarsSnapshot,
  ) => Effect.Effect<SnapshotChanges, DbQueryFailed | DbRowInvalid | AccountNotFound>;
  readonly list: (accountId: GitHubAccountId) => Effect.Effect<ReadonlyArray<Star>, DbQueryFailed | DbRowInvalid>;
  readonly library: (
    accountId: GitHubAccountId,
  ) => Effect.Effect<ReadonlyArray<LibraryEntry>, DbQueryFailed | DbRowInvalid>;
  readonly page: (
    accountId: GitHubAccountId,
    options: { readonly limit: number; readonly after: Option.Option<StarsPosition> },
  ) => Effect.Effect<StarsPage, DbQueryFailed | DbRowInvalid>;
  readonly enrichment: (login: Login) => Effect.Effect<EnrichmentProgress, DbQueryFailed | DbRowInvalid>;
}

const decodeStars = rowsDecoder(Star);
const decodeLibrary = rowsDecoder(LibraryEntry);
const decodeProgress = rowsDecoder(EnrichmentProgress);
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

const unread = unreadEnrichment(repos);

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

const encodePosition = (position: StarsPosition) =>
  encodeTime(position.starredAt).pipe(Effect.map((starredAt) => Option.some({ starredAt, repoId: position.repoId })));

// Newest star first, ties by repo ID, so a page continues after a position with no gap and no repeat. The bound on
// starred_at alone lets stars_page_idx start a later page at its position instead of reading every older star.
const libraryEntries = (
  db: Postgres.Database,
  accountId: GitHubAccountId,
  after?: { readonly starredAt: string; readonly repoId: RepoId },
) =>
  db
    .select({
      repo: repoColumns,
      starredAt: stars.starredAt,
      stars: repoMetrics.stars,
      read: sql<boolean>`not ${unread}`,
    })
    .from(stars)
    .innerJoin(repos, eq(repos.id, stars.repoId))
    .leftJoin(repoMetrics, eq(repoMetrics.repoId, stars.repoId))
    .where(
      and(
        eq(stars.accountId, accountId),
        isNull(stars.unstarredAt),
        after === undefined
          ? undefined
          : and(
              lte(stars.starredAt, sql`${after.starredAt}::timestamptz`),
              or(
                lt(stars.starredAt, sql`${after.starredAt}::timestamptz`),
                and(eq(stars.starredAt, sql`${after.starredAt}::timestamptz`), gt(stars.repoId, after.repoId)),
              ),
            ),
      ),
    )
    .orderBy(desc(stars.starredAt), stars.repoId)
    .$dynamic();

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
    library: (accountId) =>
      run("stars.library", (db) => libraryEntries(db, accountId)).pipe(Effect.flatMap(decodeLibrary("stars.library"))),
    page: (accountId, { limit, after }) =>
      Effect.flatMap(Option.match(after, { onNone: () => Effect.succeedNone, onSome: encodePosition }), (position) =>
        run("stars.page", (db) => libraryEntries(db, accountId, Option.getOrUndefined(position)).limit(limit + 1)),
      ).pipe(
        Effect.flatMap(decodeLibrary("stars.page")),
        Effect.map((rows) => {
          const entries = rows.slice(0, limit);
          const last = entries.at(-1);
          return {
            entries,
            next:
              rows.length > limit && last !== undefined
                ? Option.some({ starredAt: last.starredAt, repoId: last.repo.id })
                : Option.none(),
          };
        }),
      ),
    // The progress and the sync status describe the account accountNamed chooses.
    enrichment: (login) =>
      run("stars.enrichment", (db) =>
        db
          .select({
            total: sql<number>`count(*)::int`,
            read: sql<number>`(count(*) filter (where not ${unread}))::int`,
            failed: sql<number>`(count(*) filter (where ${unread} and ${repos.enrichFailures} >= ${enrichFailureCap}))::int`,
          })
          .from(stars)
          .innerJoin(repos, eq(repos.id, stars.repoId))
          .where(
            and(
              eq(
                stars.accountId,
                sql`(${accountNamed(db.select({ id: githubAccounts.id }).from(githubAccounts).$dynamic(), login)})`,
              ),
              isNull(stars.unstarredAt),
            ),
          ),
      ).pipe(
        Effect.flatMap(decodeProgress("stars.enrichment")),
        Effect.flatMap((rows) => Effect.orDie(Effect.fromNullishOr(rows[0]))),
      ),
  } satisfies Queries;
});
