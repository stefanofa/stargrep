import { GitHubAccountId, type Login, RepoId } from "@stargrep/github/schemas";
import { and, desc, eq, gt, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { EmbeddingModelId } from "../embedding.ts";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, requireRow, resultRows, rowsDecoder, writeEncoder } from "../rows.ts";
import {
  githubAccounts,
  type ReadingState,
  readingState,
  repoMetrics,
  repoReading,
  repos,
  stars,
  unreadEnrichment,
} from "../schema.ts";
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
  gone: Schema.Boolean,
});
export type LibraryEntry = typeof LibraryEntry.Type;

// queued counts the unread repos whose summary waits: the daily summary cap deferred it, or the summary policy holds it
// back until the repo gains stars or a signed-in user stars it. Stargrep reads them later on its own.
const EnrichmentProgress = Schema.Struct({
  total: Schema.Int,
  read: Schema.Int,
  failed: Schema.Int,
  queued: Schema.Int,
});
export type EnrichmentProgress = typeof EnrichmentProgress.Type;

export interface StarsUpsert {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarEvent>;
}

export interface StarsSnapshot {
  readonly accountId: GitHubAccountId;
  readonly stars: ReadonlyArray<StarredRepo>;
  readonly at: DateTime.Utc;
  // Whether stars holds every star the account has. Only a complete snapshot marks the stored stars it lacks unstarred.
  readonly complete: boolean;
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

// Repos one account stars now that another does not, closest to the other's own stars first.
export interface NewToYou {
  // How many repos both accounts star now.
  readonly shared: number;
  readonly entries: ReadonlyArray<LibraryEntry>;
}

export interface NewToYouRequest {
  readonly viewer: GitHubAccountId;
  readonly owner: GitHubAccountId;
  readonly limit: number;
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
  readonly newToYou: (request: NewToYouRequest) => Effect.Effect<NewToYou, DbQueryFailed | DbRowInvalid>;
}

const decodeStars = rowsDecoder(Star);
const decodeLibrary = rowsDecoder(LibraryEntry);
const decodeProgress = rowsDecoder(EnrichmentProgress);
const decodeChanged = rowsDecoder(Schema.Struct({ repoId: RepoId }));
const decodeCloseness = rowsDecoder(Schema.Struct({ shared: Schema.Int, ranked: Schema.Array(RepoId) }));
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

const column = (target: PgColumn) => sql.identifier(target.name);

const noChanges: SnapshotChanges = { starred: [], unstarred: [] };

const unread = unreadEnrichment(repos);

// A star write locks its account's row and then every repo whose synced_stargazers it can change, in ID order, before it
// writes: each listed repo the account does not star now and, for a snapshot that unstars, each repo it starred before.
// The triggers keep ID order only within one trigger, and an upsert fires its UPDATE trigger before its INSERT trigger.
// With the account held, no other star write for it changes what this reads before the commit.
const lockCountedRepos = (accountId: GitHubAccountId, listed: ReadonlyArray<RepoId>, unstarsBefore?: string) => sql`
  select id from ${repos} where id in (
    select listed.id from unnest(${sql.param([...listed])}::bigint[]) as listed (id)
    where not exists (
      select from ${stars} s where s.account_id = ${accountId} and s.repo_id = listed.id and s.unstarred_at is null
    )
    ${
      unstarsBefore === undefined
        ? sql``
        : sql`union all
          select repo_id from ${stars}
          where account_id = ${accountId} and unstarred_at is null and observed_at < ${unstarsBefore}::timestamptz`
    }
  )
  order by id for no key update`;

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
const startingAfter = (position: { readonly starredAt: string; readonly repoId: RepoId }) =>
  and(
    lte(stars.starredAt, sql`${position.starredAt}::timestamptz`),
    or(
      lt(stars.starredAt, sql`${position.starredAt}::timestamptz`),
      and(eq(stars.starredAt, sql`${position.starredAt}::timestamptz`), gt(stars.repoId, position.repoId)),
    ),
  );

const libraryEntries = (db: Postgres.Database, accountId: GitHubAccountId, condition?: SQL) =>
  db
    .select({
      repo: repoColumns,
      starredAt: stars.starredAt,
      stars: repoMetrics.stars,
      read: sql<boolean>`not ${unread}`,
      gone: sql<boolean>`${repos.goneAt} is not null`,
    })
    .from(stars)
    .innerJoin(repos, eq(repos.id, stars.repoId))
    .leftJoin(repoMetrics, eq(repoMetrics.repoId, stars.repoId))
    .where(and(eq(stars.accountId, accountId), isNull(stars.unstarredAt), condition))
    .orderBy(desc(stars.starredAt), stars.repoId)
    .$dynamic();

// Comparing every pair of two accounts' stars is millions of distances for accounts of a few thousand stars, which no
// page can wait for. So the owner's newest unshared stars are the candidates, and the viewer's stars, taken evenly
// across their whole history so a varied account keeps every interest, are the references, as many as fit the pair
// budget. A candidate's distance is its mean distance to its nearest references, so one close interest ranks a repo
// high where an average of every star would blur it. Distances compare the leading dimensions only, which measured
// the same ranking at half the time.
const candidateCap = 1500;
const pairBudget = 400_000;
const nearest = 3;
const comparedDimensions = 256;

const closeness = (model: EmbeddingModelId, { viewer, owner, limit }: NewToYouRequest) => sql`
  with theirs as materialized (
    select s.repo_id, s.starred_at, exists (
      select from ${stars} v where v.account_id = ${viewer} and v.repo_id = s.repo_id and v.unstarred_at is null
    ) as shared
    from ${stars} s where s.account_id = ${owner} and s.unstarred_at is null
  ),
  candidates as materialized (
    select t.repo_id, subvector(r.embedding, 1, ${comparedDimensions}) as embedding
    from (
      select repo_id, starred_at from theirs where not shared order by starred_at desc, repo_id limit ${candidateCap}
    ) t
    join ${repos} r on r.id = t.repo_id
    where not r.archived and r.gone_at is null and r.embedding_model = ${model}
  ),
  mine as (
    select s.repo_id, row_number() over (order by s.starred_at desc, s.repo_id) as n, count(*) over () as total
    from ${stars} s where s.account_id = ${viewer} and s.unstarred_at is null
  ),
  refs as materialized (
    select subvector(r.embedding, 1, ${comparedDimensions}) as embedding
    from mine m join ${repos} r on r.id = m.repo_id
    where r.embedding_model = ${model}
      and (m.n - 1) % greatest(1, ceil(m.total * (select count(*) from candidates) / ${pairBudget}::numeric))::int = 0
  )
  select
    (select count(*) from theirs where shared)::int as shared,
    array(
      select c.repo_id::float8 from candidates c
      cross join lateral (
        select avg(d) as distance from (
          select c.embedding <=> f.embedding as d from refs f order by d limit ${nearest}
        ) near
      ) scored
      where scored.distance is not null
      order by scored.distance, c.repo_id
      limit ${limit}
    ) as ranked`;

export const make = Effect.fn("Db.stars.make")(function* (model: EmbeddingModelId) {
  const { run, withTransaction } = yield* Postgres.Postgres;

  return {
    upsert: (input) =>
      Arr.isReadonlyArrayEmpty(input.stars)
        ? Effect.succeed([])
        : encodeEvents(input.stars).pipe(
            Effect.flatMap((events) =>
              withTransaction(
                Effect.gen(function* () {
                  yield* run("stars.upsert", (db) =>
                    db
                      .select({ id: githubAccounts.id })
                      .from(githubAccounts)
                      .where(eq(githubAccounts.id, input.accountId))
                      .for("no key update"),
                  );
                  yield* run("stars.upsert", (db) =>
                    db.execute(
                      lockCountedRepos(
                        input.accountId,
                        input.stars.map((star) => star.repoId),
                      ),
                    ),
                  );
                  return yield* run("stars.upsert", (db) =>
                    db.execute(sql`
                      with account as (
                        select ${githubAccounts.starsFullSyncedAt} as synced from ${githubAccounts}
                        where ${githubAccounts.id} = ${input.accountId}
                      ),
                      ${writeStarsReturningVisibleChanges(
                        input.accountId,
                        events,
                        sql`event."observedAt" > coalesce((select synced from account), '-infinity')`,
                      )}`),
                  );
                }),
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
              yield* run("stars.applySnapshot", (db) =>
                db.execute(
                  lockCountedRepos(
                    snapshot.accountId,
                    snapshot.stars.map((star) => star.repoId),
                    snapshot.complete ? at : undefined,
                  ),
                ),
              );
              const starred = Arr.isReadonlyArrayNonEmpty(snapshot.stars)
                ? yield* run("stars.applySnapshot", (db) =>
                    db.execute(sql`with ${writeStarsReturningVisibleChanges(snapshot.accountId, events, sql`true`)}`),
                  ).pipe(Effect.flatMap((result) => decodeChanged("stars.applySnapshot")(resultRows(result))))
                : [];
              if (!snapshot.complete) return { starred: starred.map((row) => row.repoId), unstarred: [] };
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
        run("stars.page", (db) =>
          libraryEntries(
            db,
            accountId,
            Option.match(position, { onNone: () => undefined, onSome: startingAfter }),
          ).limit(limit + 1),
        ),
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
    // The progress and the sync status describe the account accountNamed chooses. A repo the backfill has not reached
    // yet has no repo_reading row, so its state comes from its repos row.
    enrichment: (login) =>
      run("stars.enrichment", (db) => {
        const library = db
          .select({
            state:
              sql<ReadingState>`coalesce(${repoReading.state}, (select ${readingState(repos)} from ${repos} where ${repos.id} = ${stars.repoId}))`.as(
                "state",
              ),
          })
          .from(stars)
          .leftJoin(repoReading, eq(repoReading.repoId, stars.repoId))
          .where(
            and(
              eq(
                stars.accountId,
                sql`(${accountNamed(db.select({ id: githubAccounts.id }).from(githubAccounts).$dynamic(), login)})`,
              ),
              isNull(stars.unstarredAt),
            ),
          )
          .as("library");
        const counted = (state: ReadingState) =>
          sql<number>`(count(*) filter (where ${library.state} = ${state}))::int`;
        return db
          .select({
            total: sql<number>`count(*)::int`,
            read: counted("read"),
            failed: counted("failed"),
            queued: counted("queued"),
          })
          .from(library);
      }).pipe(
        Effect.flatMap(decodeProgress("stars.enrichment")),
        Effect.flatMap((rows) => Effect.orDie(Effect.fromNullishOr(rows[0]))),
      ),
    newToYou: Effect.fn("Db.stars.newToYou")(function* (request) {
      const [found] = yield* run("stars.newToYou", (db) => db.execute(closeness(model, request))).pipe(
        Effect.flatMap((result) => decodeCloseness("stars.newToYou")(resultRows(result))),
      );
      const ranked = found?.ranked ?? [];
      if (ranked.length === 0) return { shared: found?.shared ?? 0, entries: [] };
      const rows = yield* run("stars.newToYou", (db) =>
        libraryEntries(db, request.owner, sql`${stars.repoId} = any(${sql.param([...ranked])}::bigint[])`),
      ).pipe(Effect.flatMap(decodeLibrary("stars.newToYou")));
      const rank = new Map(ranked.map((id, index) => [id, index]));
      return {
        shared: found?.shared ?? 0,
        entries: rows.toSorted((a, b) => (rank.get(a.repo.id) ?? 0) - (rank.get(b.repo.id) ?? 0)),
      };
    }),
  } satisfies Queries;
});
