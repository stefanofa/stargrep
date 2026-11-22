import { GitHubAccountId, Login, RepoId } from "@stargrep/github/schemas";
import { and, eq, isNull, sql } from "drizzle-orm";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { only, rowsDecoder, statements, timeParam } from "../rows.ts";
import { follows, githubAccounts, repoMetrics, repos, stars } from "../schema.ts";
import type { Stargazers } from "./people.ts";
import { Repo, repoColumns } from "./repos.ts";

export const FollowSource = Schema.Literals(["github", "stargrep"]);
export type FollowSource = typeof FollowSource.Type;

const Millis = Schema.DateTimeUtcFromMillis;

const Followee = Schema.Struct({
  id: GitHubAccountId,
  login: Login,
  avatarUrl: Schema.NullOr(Schema.String),
  source: FollowSource,
  followedAt: Millis,
  starsSyncedAt: Schema.NullOr(Millis),
  // The latest time Stargrep found the account's stored stars current, by a sync or by the star check.
  checkedAt: Schema.NullOr(Millis),
  lastStarredAt: Schema.NullOr(Millis),
});
export type Followee = typeof Followee.Type;

// One current star of a followee, and whether the follower stars the repo too.
const FeedStar = Schema.Struct({
  followee: GitHubAccountId,
  repoId: RepoId,
  starredAt: Millis,
  mine: Schema.Boolean,
});
export type FeedStar = typeof FeedStar.Type;

const FeedRepo = Schema.Struct({ repo: Repo, stars: Schema.NullOr(Schema.Int) });
export type FeedRepo = typeof FeedRepo.Type;

const Known = Schema.Struct({ id: GitHubAccountId, login: Login, avatarUrl: Schema.NullOr(Schema.String) });
export type Known = typeof Known.Type;

const FollowedSince = Schema.Struct({ login: Login, followedAt: Millis });
export type FollowedSince = typeof FollowedSince.Type;

const Followed = Schema.Struct({
  following: Schema.Array(Login),
  added: Schema.Int,
  total: Schema.Int,
  full: Schema.Boolean,
});
export type Followed = typeof Followed.Type;

export interface Follow {
  readonly follower: GitHubAccountId;
  readonly logins: ReadonlyArray<Login>;
  readonly source: FollowSource;
  // How many accounts the follower may follow in all. Logins past it are left out, in the order given.
  readonly cap: number;
}

export interface FeedQuery {
  readonly follower: GitHubAccountId;
  readonly since: DateTime.Utc;
  // How many of each followee's newest stars to read, so one busy account cannot fill the feed.
  readonly perFollowee: number;
}

export interface Queries {
  // Follows the users these logins name, never the follower or an org, up to the cap. following lists every login now
  // followed, in the order given, and full says the cap left some out.
  readonly follow: (follow: Follow) => Effect.Effect<Followed, DbQueryFailed | DbRowInvalid>;
  // Whether a follow was there to remove.
  readonly unfollow: (follower: GitHubAccountId, login: Login) => Effect.Effect<boolean, DbQueryFailed>;
  // Everyone the follower follows, the newest follow first.
  readonly list: (follower: GitHubAccountId) => Effect.Effect<ReadonlyArray<Followee>, DbQueryFailed | DbRowInvalid>;
  // Whom the follower follows and since when, the newest follow first, without reading their stars.
  readonly followed: (
    follower: GitHubAccountId,
  ) => Effect.Effect<ReadonlyArray<FollowedSince>, DbQueryFailed | DbRowInvalid>;
  // The followees' current stars made since the time, newest first per followee.
  readonly stars: (query: FeedQuery) => Effect.Effect<ReadonlyArray<FeedStar>, DbQueryFailed | DbRowInvalid>;
  // The repos with their star counts, leaving out repos GitHub no longer serves.
  readonly repos: (ids: ReadonlyArray<RepoId>) => Effect.Effect<ReadonlyArray<FeedRepo>, DbQueryFailed | DbRowInvalid>;
  // The followees who star the repo now, the latest star first, leaving out the account whose page shows it.
  readonly starredBy: (query: {
    readonly follower: GitHubAccountId;
    readonly repoId: RepoId;
    readonly except: GitHubAccountId;
    readonly limit: number;
  }) => Effect.Effect<Stargazers, DbQueryFailed | DbRowInvalid>;
  // The users among these accounts whose stars Stargrep has synced, the most followed first.
  readonly known: (
    ids: ReadonlyArray<GitHubAccountId>,
  ) => Effect.Effect<ReadonlyArray<Known>, DbQueryFailed | DbRowInvalid>;
}

const decodeFollowees = rowsDecoder(Followee);
const decodeFeedStars = rowsDecoder(FeedStar);
const decodeFeedRepos = rowsDecoder(FeedRepo);
const decodeKnown = rowsDecoder(Known);
const decodeFollowResult = rowsDecoder(Followed);
const decodeFollowed = rowsDecoder(FollowedSince);
const decodeStargazers = rowsDecoder(
  Schema.Struct({ login: Login, avatarUrl: Schema.NullOr(Schema.String), total: Schema.Int }),
);

// Whole milliseconds, because a default now() carries microseconds.
const millis = (column: string) => sql.raw(`floor(extract(epoch from ${column}) * 1000)::float8`);

// When the account's stars were last found current, by a sync or by the star check.
const checkedAt = sql.raw("greatest(a.stars_synced_at, a.stars_checked_at)");

export const make = Effect.gen(function* () {
  const { run, withTransaction } = yield* Postgres.Postgres;
  const { query, execute } = statements(run);

  return {
    // A login names the account accountNamed would choose: the one synced most recently, then the lowest ID. The
    // follower's writes take turns under a lock held to the end of the transaction, and the count and the insert run in a
    // later statement, whose snapshot sees every follow committed before it, so concurrent batches never pass the cap.
    follow: Effect.fn("Db.follows.follow")(function* ({ follower, logins, source, cap }) {
      return yield* withTransaction(
        execute("follows.lock", sql`select pg_advisory_xact_lock(hashtextextended(${`follows/${follower}`}, 0))`).pipe(
          Effect.andThen(
            query(
              "follows.follow",
              decodeFollowResult,
              sql`
          with wanted as (
            select distinct on (lower(a.login)) a.id, a.login, w.ord
            from unnest(${sql.param([...logins])}::text[]) with ordinality as w(login, ord)
            join ${githubAccounts} a on lower(a.login) = lower(w.login)
            where a.type = 'user' and a.id <> ${follower}
            order by lower(a.login), a.stars_synced_at desc nulls last, a.id
          ),
          had as (select count(*)::int as n from ${follows} where follower_id = ${follower}),
          fresh as (
            select w.id from wanted w
            where not exists (select from ${follows} f where f.follower_id = ${follower} and f.followee_id = w.id)
          ),
          added as (
            insert into ${follows} (follower_id, followee_id, source)
            select ${follower}, w.id, ${source}::follow_source
            from wanted w where w.id in (select id from fresh)
            order by w.ord
            limit greatest(${cap} - (select n from had), 0)
            on conflict do nothing
            returning followee_id
          )
          select
            coalesce((
              select json_agg(w.login order by w.ord) from wanted w
              where w.id in (select followee_id from added) or w.id not in (select id from fresh)
            ), '[]'::json) as following,
            (select count(*)::int from added) as added,
            (select n from had) + (select count(*)::int from added) as total,
            (select count(*) from fresh) > (select count(*) from added) as full`,
            ),
          ),
          Effect.flatMap(only),
        ),
      );
    }),

    unfollow: (follower, login) =>
      run("follows.unfollow", (db) =>
        db
          .delete(follows)
          .where(
            and(
              eq(follows.followerId, follower),
              sql`${follows.followeeId} in (select id from ${githubAccounts} where lower(login) = lower(${login}))`,
            ),
          )
          .returning({ followeeId: follows.followeeId }),
      ).pipe(Effect.map((rows) => rows.length > 0)),

    // Each followee's latest star comes from stars_page_idx, one probe per followee.
    list: (follower) =>
      query(
        "follows.list",
        decodeFollowees,
        sql`
          select a.id::float8 as id, a.login, a.avatar_url as "avatarUrl", f.source,
            ${millis("f.created_at")} as "followedAt", ${millis("a.stars_synced_at")} as "starsSyncedAt",
            floor(extract(epoch from ${checkedAt}) * 1000)::float8 as "checkedAt",
            ${millis("l.starred_at")} as "lastStarredAt"
          from ${follows} f
          join ${githubAccounts} a on a.id = f.followee_id
          left join lateral (
            select s.starred_at from ${stars} s
            where s.account_id = a.id and s.unstarred_at is null
            order by s.starred_at desc nulls first, s.repo_id
            limit 1
          ) l on true
          where f.follower_id = ${follower}
          order by f.created_at desc, a.id`,
      ),

    followed: (follower) =>
      query(
        "follows.followed",
        decodeFollowed,
        sql`
          select a.login, ${millis("f.created_at")} as "followedAt"
          from ${follows} f join ${githubAccounts} a on a.id = f.followee_id
          where f.follower_id = ${follower}
          order by f.created_at desc, a.id`,
      ),

    // One range read of stars_page_idx per followee. On a branch of prod, 50 followees took 0.9 ms and 354 took 4.5 ms.
    stars: ({ follower, since, perFollowee }) =>
      query(
        "follows.stars",
        decodeFeedStars,
        sql`
          select s.account_id::float8 as followee, s.repo_id::float8 as "repoId", ${millis("s.starred_at")} as "starredAt",
            exists (
              select from ${stars} v where v.account_id = ${follower} and v.repo_id = s.repo_id and v.unstarred_at is null
            ) as mine
          from ${follows} f
          cross join lateral (
            select s.account_id, s.repo_id, s.starred_at from ${stars} s
            where s.account_id = f.followee_id and s.unstarred_at is null and s.starred_at >= ${timeParam(since)}
            order by s.starred_at desc nulls first, s.repo_id
            limit ${perFollowee}
          ) s
          where f.follower_id = ${follower}`,
      ),

    repos: (ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : run("follows.repos", (db) =>
            db
              .select({ repo: repoColumns, stars: repoMetrics.stars })
              .from(repos)
              .leftJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
              .where(and(sql`${repos.id} = any(${sql.param([...ids])}::bigint[])`, isNull(repos.goneAt))),
          ).pipe(Effect.flatMap(decodeFeedRepos("follows.repos"))),

    // One stars primary key probe per followee.
    starredBy: Effect.fn("Db.follows.starredBy")(function* ({ follower, repoId, except, limit }) {
      const found = yield* query(
        "follows.starredBy",
        decodeStargazers,
        sql`
          select a.login, a.avatar_url as "avatarUrl", count(*) over ()::int as total
          from ${follows} f
          join ${stars} s on s.account_id = f.followee_id and s.repo_id = ${repoId} and s.unstarred_at is null
          join ${githubAccounts} a on a.id = f.followee_id
          where f.follower_id = ${follower} and f.followee_id <> ${except}
          order by s.starred_at desc, a.id
          limit ${limit}`,
      );
      return {
        people: found.map(({ login, avatarUrl }) => ({ login, avatarUrl })),
        total: found[0]?.total ?? 0,
      };
    }),

    known: (ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : query(
            "follows.known",
            decodeKnown,
            sql`
              select a.id::float8 as id, a.login, a.avatar_url as "avatarUrl" from ${githubAccounts} a
              where a.id = any(${sql.param([...ids])}::bigint[]) and a.type = 'user' and a.stars_synced_at is not null
              order by a.followers desc nulls last, a.id`,
          ),
  } satisfies Queries;
});
