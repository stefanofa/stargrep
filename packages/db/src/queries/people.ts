import { GitHubAccountId, Login, type RepoId } from "@stargrep/github/schemas";
import { type SQL, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { only, rowsDecoder, statements, timeParam } from "../rows.ts";
import { githubAccounts, people, peopleStars, repos, stars } from "../schema.ts";

// Who the people list holds besides the curated accounts: users with this many followers and current stars, who
// starred something within the window.
export const peopleRule = { followers: 5000, stars: 40, activeWithin: Duration.days(90) } as const;

// How many of each person's languages and topics a card shows.
const cardTop = 3;

// How many of the topics the cards show a page lists to filter by.
const topicChoices = 20;

// A recount reads the repo row of every star it copies, and a cold read cost about 0.7 ms on a branch of prod, so one
// statement takes people up to this many stars in all, about 7 s cold, well inside the long statement limit. A person
// with more stars than this goes alone.
const recountStars = 10_000;

const Language = Schema.Struct({ language: Schema.String, share: Schema.Finite });

const Person = Schema.Struct({
  accountId: GitHubAccountId,
  login: Login,
  avatarUrl: Schema.NullOr(Schema.String),
  curated: Schema.Boolean,
  stars: Schema.Int,
  lastStarredAt: Schema.DateTimeUtcFromMillis,
  languages: Schema.Array(Language),
  topics: Schema.Array(Schema.String),
  shared: Schema.NullOr(Schema.Int),
});
export type Person = typeof Person.Type;

const Liked = Schema.Struct({ ...Person.fields, shared: Schema.Int });
export type Liked = typeof Liked.Type;

const Stargazer = Schema.Struct({ login: Login, avatarUrl: Schema.NullOr(Schema.String), total: Schema.Int });

export interface Stargazers {
  readonly people: ReadonlyArray<{ readonly login: Login; readonly avatarUrl: string | null }>;
  // How many listed people star the repo, the ones past the limit included.
  readonly total: number;
}

export type PeopleSort = "recently-active" | "most-like-you";

export interface PeopleQuery {
  readonly sort: PeopleSort;
  // The account whose shared stars each person carries. Without one, shared is null and most-like-you sorts as
  // recently-active. The account itself is left out of the list.
  readonly viewer: Option.Option<GitHubAccountId>;
  // Keeps only the people whose card shows this topic.
  readonly topic: Option.Option<string>;
  readonly offset: number;
  readonly limit: number;
}

const CardTopic = Schema.Struct({ topic: Schema.String, people: Schema.Int });
export type CardTopic = typeof CardTopic.Type;

export interface PeoplePage {
  readonly people: ReadonlyArray<Person>;
  // How many people the page's filter keeps.
  readonly total: number;
  // The topics the cards show, on the most cards first, whatever the topic filter.
  readonly topics: ReadonlyArray<CardTopic>;
}

export interface Refreshed {
  readonly listed: number;
  readonly recounted: number;
}

export interface Queries {
  // Lists every account the rule or the curated logins pick, then reads the stars of each one that synced since its
  // last read: its card's languages and topics, and its copy in people_stars.
  readonly refresh: (
    curated: ReadonlyArray<Login>,
    now: DateTime.Utc,
  ) => Effect.Effect<Refreshed, DbQueryFailed | DbRowInvalid>;
  readonly page: (query: PeopleQuery) => Effect.Effect<PeoplePage, DbQueryFailed | DbRowInvalid>;
  // The people who share the most stars with the account, for their size, each with the count. The account is left
  // out, and so is anyone it shares none with.
  readonly like: (
    accountId: GitHubAccountId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Liked>, DbQueryFailed | DbRowInvalid>;
  // The listed people who star the repo now, curated first, then most followed. The account is left out, so a person's
  // own page doesn't name them.
  readonly starredBy: (query: {
    readonly repoId: RepoId;
    readonly except: GitHubAccountId;
    readonly limit: number;
  }) => Effect.Effect<Stargazers, DbQueryFailed | DbRowInvalid>;
}

const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const decodePeople = rowsDecoder(Person);
const decodeLiked = rowsDecoder(Liked);
const decodeStargazers = rowsDecoder(Stargazer);
const decodeCardTopics = rowsDecoder(CardTopic);

// How many current stars the account shares with each person, from the copy, one index probe per star of the account.
const sharedWith = (accountId: GitHubAccountId) => sql`
  select ps.account_id, count(*)::int as n
  from ${stars} v join ${peopleStars} ps on ps.repo_id = v.repo_id
  where v.account_id = ${accountId} and v.unstarred_at is null
  group by ps.account_id`;

const personColumns = (shared: SQL) => sql`
  p.account_id::float8 as "accountId", a.login, a.avatar_url as "avatarUrl", p.curated, p.stars,
  (extract(epoch from p.last_starred_at) * 1000)::float8 as "lastStarredAt", p.languages, p.topics, ${shared} as shared`;

// Shared over the square root of the person's stars, so a person with thousands of stars doesn't rank first by volume.
// The other account's own count would divide every row alike, so it is left out.
const likeness = sql`s.n / sqrt(p.stars)`;

export const make = Effect.gen(function* () {
  const { run, withLongTimeout } = yield* Postgres.Postgres;
  const { query } = statements(run);

  // Each person's current stars come from stars_page_idx alone. A person who leaves the list loses their copy with the
  // row, and the next refresh after they return reads their stars again.
  const list = (curated: ReadonlyArray<Login>, now: DateTime.Utc) => {
    const logins = sql`${sql.param(curated.map((login) => login.toLowerCase()))}::text[]`;
    const since = timeParam(DateTime.subtractDuration(now, peopleRule.activeWithin));
    return withLongTimeout(
      query(
        "people.list",
        decodeCount,
        sql`
          with candidate as (
            select a.id, lower(a.login) = any(${logins}) as curated
            from ${githubAccounts} a
            where (a.type = 'user' and a.followers >= ${peopleRule.followers}) or lower(a.login) = any(${logins})
          ),
          chosen as (
            select c.id, c.curated, counted.stars, counted.last_starred_at
            from candidate c
            cross join lateral (
              select count(*)::int as stars, max(s.starred_at) as last_starred_at
              from ${stars} s where s.account_id = c.id and s.unstarred_at is null
            ) counted
            where counted.stars > 0
              and (c.curated or (counted.stars >= ${peopleRule.stars} and counted.last_starred_at > ${since}))
          ),
          dropped as (
            delete from ${people} where account_id not in (select id from chosen)
          ),
          kept as (
            insert into ${people} (account_id, curated, stars, last_starred_at)
            select id, curated, stars, last_starred_at from chosen
            on conflict (account_id) do update set
              curated = excluded.curated, stars = excluded.stars, last_starred_at = excluded.last_starred_at
            where (people.curated, people.stars, people.last_starred_at)
              is distinct from (excluded.curated, excluded.stars, excluded.last_starred_at)
          )
          select count(*)::int as count from chosen`,
      ),
    ).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    );
  };

  // The people due a read, in ID order, up to recountStars stars in all, and always at least one. The copy changes only by the
  // stars that started or ended since, and the card's shares are of all the person's current stars.
  const recount = withLongTimeout(
    query(
      "people.recount",
      decodeCount,
      sql`
        with batch as (
          select account_id, stars_synced_at from (
            select p.account_id, a.stars_synced_at, sum(p.stars) over (order by p.account_id) as through,
              row_number() over (order by p.account_id) as place
            from ${people} p join ${githubAccounts} a on a.id = p.account_id
            where p.synced_at is distinct from a.stars_synced_at
          ) due
          where through <= ${recountStars} or place = 1
        ),
        current as (
          select s.account_id, s.repo_id
          from batch b join ${stars} s on s.account_id = b.account_id and s.unstarred_at is null
        ),
        dropped as (
          delete from ${peopleStars} ps using batch b
          where ps.account_id = b.account_id and not exists (
            select from ${stars} s where s.account_id = ps.account_id and s.repo_id = ps.repo_id and s.unstarred_at is null
          )
        ),
        copied as (
          insert into ${peopleStars} (account_id, repo_id) select account_id, repo_id from current
          on conflict do nothing
        ),
        described as (
          select c.account_id, r.language, r.topics from current c join ${repos} r on r.id = c.repo_id
        ),
        totals as (
          select account_id, count(*) as n from current group by account_id
        ),
        top_languages as (
          select account_id,
            jsonb_agg(jsonb_build_object('language', language, 'share', share) order by n desc, language) as languages
          from (
            select d.account_id, d.language, count(*) as n, round(count(*)::numeric / t.n, 3)::float8 as share,
              row_number() over (partition by d.account_id order by count(*) desc, d.language) as rank
            from described d join totals t on t.account_id = d.account_id
            where d.language is not null
            group by d.account_id, d.language, t.n
          ) ranked
          where rank <= ${cardTop}
          group by account_id
        ),
        top_topics as (
          select account_id, jsonb_agg(topic order by n desc, topic) as topics
          from (
            select d.account_id, tag.topic, count(*) as n,
              row_number() over (partition by d.account_id order by count(*) desc, tag.topic) as rank
            from described d cross join lateral jsonb_array_elements_text(d.topics) as tag (topic)
            group by d.account_id, tag.topic
          ) ranked
          where rank <= ${cardTop}
          group by account_id
        ),
        updated as (
          update ${people} p set
            languages = coalesce(l.languages, '[]'::jsonb),
            topics = coalesce(t.topics, '[]'::jsonb),
            synced_at = b.stars_synced_at
          from batch b
          left join top_languages l on l.account_id = b.account_id
          left join top_topics t on t.account_id = b.account_id
          where p.account_id = b.account_id
          returning 1
        )
        select count(*)::int as count from updated`,
    ),
  ).pipe(
    Effect.flatMap(only),
    Effect.map((row) => row.count),
  );

  // Each recount clears what it read, so the loop ends once every listed person is read since their last sync.
  const recountAll = (done: number): Effect.Effect<number, DbQueryFailed | DbRowInvalid> =>
    Effect.flatMap(recount, (count) => (count === 0 ? Effect.succeed(done) : recountAll(done + count)));

  return {
    refresh: Effect.fn("Db.people.refresh")(function* (curated, now) {
      const listed = yield* list(curated, now);
      return { listed, recounted: yield* recountAll(0) };
    }),

    page: Effect.fn("Db.people.page")(function* ({ sort, viewer, topic, offset, limit }) {
      const order =
        sort === "most-like-you" && Option.isSome(viewer)
          ? sql`${likeness} desc nulls last, s.n desc nulls last, p.last_starred_at desc, p.account_id`
          : sql`p.last_starred_at desc, p.account_id`;
      const listed = Option.match(viewer, {
        onNone: () => ({ shared: sql`null::int`, from: sql``, where: sql`true` }),
        onSome: (id) => ({
          shared: sql`coalesce(s.n, 0)`,
          from: sql`left join (${sharedWith(id)}) s on s.account_id = p.account_id`,
          where: sql`p.account_id <> ${id}`,
        }),
      });
      const kept = Option.match(topic, {
        onNone: () => listed.where,
        onSome: (shown) => sql`${listed.where} and p.topics @> jsonb_build_array(${shown}::text)`,
      });
      const [found, [counted], topics] = yield* Effect.all(
        [
          query(
            "people.page",
            decodePeople,
            sql`
              select ${personColumns(listed.shared)}
              from ${people} p join ${githubAccounts} a on a.id = p.account_id ${listed.from}
              where ${kept}
              order by ${order}
              limit ${limit} offset ${offset}`,
          ),
          query("people.page", decodeCount, sql`select count(*)::int as count from ${people} p where ${kept}`),
          query(
            "people.page",
            decodeCardTopics,
            sql`
              select shown.topic, count(*)::int as people
              from ${people} p cross join jsonb_array_elements_text(p.topics) as shown (topic)
              where ${listed.where}
              group by shown.topic
              order by people desc, shown.topic
              limit ${topicChoices}`,
          ),
        ],
        { concurrency: 3 },
      );
      return { people: found, total: counted?.count ?? 0, topics };
    }),

    like: (accountId, limit) =>
      query(
        "people.like",
        decodeLiked,
        sql`
          select ${personColumns(sql`s.n`)}
          from (${sharedWith(accountId)}) s
          join ${people} p on p.account_id = s.account_id
          join ${githubAccounts} a on a.id = p.account_id
          where p.account_id <> ${accountId}
          order by ${likeness} desc, s.n desc, p.account_id
          limit ${limit}`,
      ),

    // One probe of people_stars_repo_idx, so a repo every listed person stars reads a few hundred entries.
    starredBy: Effect.fn("Db.people.starredBy")(function* ({ repoId, except, limit }) {
      const found = yield* query(
        "people.starredBy",
        decodeStargazers,
        sql`
          select a.login, a.avatar_url as "avatarUrl", count(*) over ()::int as total
          from ${peopleStars} ps
          join ${people} p on p.account_id = ps.account_id
          join ${githubAccounts} a on a.id = ps.account_id
          where ps.repo_id = ${repoId} and ps.account_id <> ${except}
          order by p.curated desc, a.followers desc nulls last, ps.account_id
          limit ${limit}`,
      );
      return {
        people: found.map(({ login, avatarUrl }) => ({ login, avatarUrl })),
        total: found[0]?.total ?? 0,
      };
    }),
  } satisfies Queries;
});
