import { Login, type RepoId } from "@stargrep/github/schemas";
import type { KindId } from "@stargrep/knowledge/registry";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid, Operation } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, statements } from "../rows.ts";
import {
  githubAccounts,
  people,
  peopleStars,
  repoMetrics,
  repos,
  repoTopics,
  stars,
  topicRepos,
  topics,
} from "../schema.ts";
import { Repo, RepoIcon, repoColumns } from "./repos.ts";

// Which topics get a page and what each page keeps. A topic is read once it tags `considered` repos, and gets a page
// once `gate` of its core repos have `devs` synced developers who star them, the count it ranks by. A synced developer
// is into a topic once they star `into` of its core repos.
export const topicRule = {
  considered: 30,
  gate: 20,
  devs: 3,
  into: 3,
  core: 48,
  built: 12,
  builtAtLeast: 6,
  related: 8,
  relatedShared: 10,
  people: 6,
  peopleAtLeast: 5,
  // How many topics one statement of the refresh reads.
  chunk: 1000,
} as const;

// Kinds that make a tagged repo core to its topic, and the kind that makes it one built with the topic.
const coreKinds: ReadonlyArray<KindId> = [
  "library",
  "framework",
  "cli",
  "plugin",
  "template",
  "list",
  "config",
  "database",
];
const builtKinds: ReadonlyArray<KindId> = ["app"];

// Spellings GitHub keeps as separate topics for one thing. A page lists the repos of every spelling, and an address
// with another spelling leads to the canonical one.
export const topicAliases: Readonly<Record<string, string>> = {
  next: "nextjs",
  "next-js": "nextjs",
  "next.js": "nextjs",
  nextjs14: "nextjs",
  nextjs15: "nextjs",
  reactjs: "react",
  "react-js": "react",
  golang: "go",
  python3: "python",
  vuejs: "vue",
  "vue-js": "vue",
  sveltejs: "svelte",
  astrojs: "astro",
  "rust-lang": "rust",
  tailwind: "tailwindcss",
  "tailwind-css": "tailwindcss",
  "node-js": "nodejs",
  k8s: "kubernetes",
  postgres: "postgresql",
  pgsql: "postgresql",
  shadcn: "shadcn-ui",
  js: "javascript",
  ts: "typescript",
  "c-plus-plus": "cpp",
  "c-sharp": "csharp",
};

// Topics people add to collect events, contributions, or showcases rather than to say what a repo is.
const blocked =
  "^(hacktoberfest.*|awesome|portfolio|beginner|project|good-first-issue|first-contributions|first-timers-only|up-for-grabs)$";

// Calls made by hand about single topics, after reading their lists.
// - strict: topics whose tag also means something else, such as effect, which visual effects repos carry too. Only a
//   repo's facets give it a role there: a tag with a kind makes no repo core or built, and names no home.
// - excludes: repos a topic leaves out of its lists and search, by GitHub ID, such as ones whose facets file them under
//   the topic wrongly.
export const topicOverrides: {
  readonly strict: ReadonlyArray<string>;
  readonly excludes: Readonly<Record<string, Readonly<Record<string, number>>>>;
} = {
  strict: ["effect"],
  excludes: {
    astro: {
      "yoavbls/pretty-ts-errors": 530861050,
      "uidotdev/usehooks": 164721045,
      "appcypher/awesome-wasm-langs": 114363116,
    },
  },
};

export const canonicalTopic = (topic: string): string => {
  const typed = topic.trim().toLowerCase();
  return topicAliases[typed] ?? typed;
};

// A topic's own repo, by its owner and icon, which may stand for the topic. Gone and archived repos stand for none.
const TopicHome = Schema.Struct({ owner: Schema.String, icon: Schema.NullOr(RepoIcon) });
export type TopicHome = typeof TopicHome.Type;

const TopicCount = Schema.Struct({
  topic: Schema.String,
  repos: Schema.Int,
  ranked: Schema.Int,
  devs: Schema.Int,
  home: Schema.NullOr(TopicHome),
});
export type TopicCount = typeof TopicCount.Type;

const TopicRow = Schema.Struct({
  topic: Schema.String,
  repos: Schema.Int,
  ranked: Schema.Int,
  devs: Schema.Int,
  home: Schema.NullOr(Schema.Finite),
  core: Schema.Array(Schema.Finite),
  built: Schema.Array(Schema.Finite),
  related: Schema.Array(TopicCount),
});

const TopicPerson = Schema.Struct({
  login: Login,
  avatarUrl: Schema.NullOr(Schema.String),
  // How many of the topic's core repos the person stars, and how many repos they star in all.
  repos: Schema.Int,
  stars: Schema.Int,
});
export type TopicPerson = typeof TopicPerson.Type;

const TopicRepo = Schema.Struct({
  repo: Repo,
  // How many synced developers star the repo now, and GitHub's count.
  devs: Schema.Int,
  stars: Schema.NullOr(Schema.Int),
});
export type TopicRepo = typeof TopicRepo.Type;

export interface TopicPage {
  readonly topic: string;
  readonly repos: number;
  readonly ranked: number;
  readonly devs: number;
  readonly home: Option.Option<TopicRepo>;
  readonly core: ReadonlyArray<TopicRepo>;
  readonly built: ReadonlyArray<TopicRepo>;
  readonly related: ReadonlyArray<TopicCount>;
  readonly people: ReadonlyArray<TopicPerson>;
}

export interface TopicsQuery {
  // Text the topic's name holds. Empty lists every topic.
  readonly q: string;
  readonly offset: number;
  readonly limit: number;
}

export interface TopicsPage {
  readonly topics: ReadonlyArray<TopicCount>;
  readonly total: number;
}

export interface Refreshed {
  readonly considered: number;
  readonly members: number;
  readonly listed: number;
}

export interface Queries {
  // Reads the role of every repo of every topic that tags enough repos, then lists the topics that get a page, each
  // with its ranked repos, related topics, and people.
  readonly refresh: () => Effect.Effect<Refreshed, DbQueryFailed | DbRowInvalid>;
  // The topic's page, by its canonical name, or none when it gets no page.
  readonly page: (topic: string) => Effect.Effect<Option.Option<TopicPage>, DbQueryFailed | DbRowInvalid>;
  // The listed topic a typed name means: itself, the one an alias names, or one spelled the same but for hyphens.
  readonly resolve: (typed: string) => Effect.Effect<Option.Option<string>, DbQueryFailed | DbRowInvalid>;
  // Each typed name that means a listed topic, with that topic, as resolve finds it.
  readonly pages: (
    typed: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TopicPageLink>, DbQueryFailed | DbRowInvalid>;
  // How many repos the topic's search reads, or none when it gets no page.
  readonly size: (topic: string) => Effect.Effect<Option.Option<number>, DbQueryFailed | DbRowInvalid>;
  // The listed topics, most ranked repos first. A query puts the names that start with it before the ones that hold it.
  readonly list: (query: TopicsQuery) => Effect.Effect<TopicsPage, DbQueryFailed | DbRowInvalid>;
}

const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const Spelling = Schema.Struct({ topic: Schema.String, spelling: Schema.String });
type Spelling = typeof Spelling.Type;
const decodeSpellings = rowsDecoder(Spelling);
const decodeTopicRows = rowsDecoder(TopicRow);
const decodeTopicCounts = rowsDecoder(Schema.Struct({ ...TopicCount.fields, total: Schema.Int }));
const decodePeople = rowsDecoder(TopicPerson);
const decodeRepos = rowsDecoder(Schema.Struct({ ...TopicRepo.fields, id: Schema.Finite, gone: Schema.Boolean }));
const TopicPageLink = Schema.Struct({ topic: Schema.String, page: Schema.String });
export type TopicPageLink = typeof TopicPageLink.Type;
const decodePages = rowsDecoder(TopicPageLink);
const decodeSize = rowsDecoder(Schema.Struct({ repos: Schema.Int }));

const textArray = (values: ReadonlyArray<string>) => sql`${sql.param(values)}::text[]`;

// The home repo of the topic row t, joined as h, as a TopicHome.
const homeJoin = (t: SQL) => sql`left join ${repos} h on h.id = ${t}.home and h.gone_at is null and not h.archived`;
const homeObject = sql`case when h.id is null then null else jsonb_build_object('owner', h.owner, 'icon',
  case when h.icon_key is null then null
  else jsonb_build_object('key', h.icon_key, 'source', h.icon_source, 'plate', h.icon_plate, 'size', h.icon_size) end) end`;
const aliasPairs = Object.entries(topicAliases);
const aliases = sql`unnest(${textArray(aliasPairs.map(([alias]) => alias))}, ${textArray(aliasPairs.map(([, canonical]) => canonical))}) as a (alias, canonical)`;

// Every canonical topic tagging enough repos to be read, with each spelling of it repos carry. Spellings the alias map
// names, and ones that differ only by hyphens, such as deeplearning and deep-learning, fold into the most used one.
// Blocked topics are left out.
const considered = sql`
  with spelled as (
    select coalesce(a.canonical, t.topic) as name, t.topic as spelling, t.repo_id
    from ${repoTopics} t left join ${aliases} on a.alias = t.topic
  ),
  sized as (select name, count(*) as n from spelled group by name),
  folded as (
    select name, first_value(name) over (partition by replace(name, '-', '') order by n desc, name) as topic from sized
  ),
  grouped as (
    select f.topic, s.spelling, s.repo_id from spelled s join folded f on f.name = s.name where f.topic !~ ${blocked}
  ),
  kept as (
    select topic from grouped group by topic having count(distinct repo_id) >= ${topicRule.considered}
  )
  select distinct g.topic, g.spelling from grouped g join kept k on k.topic = g.topic order by 1, 2`;

// Each named topic's repos and their roles. A topic's subjects are the public accepted subjects whose label key spells
// it, with dots, spaces, underscores, and hyphens left out, and every subject merged into one of them. Facets that say
// a repo is for or about one make it core, and built with one makes it built. A tagged repo of a core kind is core and
// one of an app kind is built, so a kind beats a built-with facet. The subjects' own repo, and any tagged repo named like
// the topic, may be its home. A strict topic's tags give no role. repo_topics holds only repos GitHub serves that are
// not archived, and every archived or gone repo is left out, so no other repo is a member. Those come whole from two
// small partial indexes, because checking each faceted repo's row read about 150k heap pages a statement.
const members = (spelled: ReadonlyArray<Spelling>) => {
  const excluded = Object.entries(topicOverrides.excludes).flatMap(([topic, ids]) =>
    Object.values(ids).map((id) => [topic, id] as const),
  );
  return sql`
    with spellings as (
      select * from unnest(
        ${textArray(spelled.map(({ topic }) => topic))}, ${textArray(spelled.map(({ spelling }) => spelling))}
      ) as s (topic, spelling)
    ),
    names as (select distinct topic from spellings),
    tagged as (
      select s.topic, t.repo_id, t.kinds, t.name_key = regexp_replace(s.topic, '[^a-z0-9]', '', 'g') as named,
        s.topic = any(${textArray(topicOverrides.strict)}) as strict
      from spellings s join ${repoTopics} t on t.topic = s.spelling
    ),
    labelled as (
      select n.topic, l.subject_id, s.repo_id as home, s.repo_count
      from names n
      join knowledge_labels l on l.namespace = 'public'
        and regexp_replace(l.key, '[.\\s_-]', '', 'g') = replace(n.topic, '-', '')
      join subjects s on s.id = l.subject_id and s.status = 'accepted'
    ),
    subjects_of as (
      select topic, array_agg(distinct subject_id) || knowledge_origins(array_agg(distinct subject_id), false) as ids,
        (array_agg(home order by repo_count desc) filter (where home is not null))[1] as home
      from labelled group by topic
    ),
    faceted as (
      select s.topic, f.repo_id, (f.for_subjects && s.ids or f.about && s.ids) as core, f.built_with && s.ids as built
      from subjects_of s join repo_facets f on (f.members && s.ids or f.built_with && s.ids)
      where f.for_subjects && s.ids or f.about && s.ids or f.built_with && s.ids
    ),
    dead as (
      select id as repo_id from ${repos} where archived and gone_at is null
      union all
      select id from ${repos} where gone_at is not null
    ),
    roles as (
      select topic, repo_id,
        case
          when bool_or(home) then 'home'
          when bool_or(core) or bool_or(kinds && ${sql.param(coreKinds)}::knowledge_kind[]) then 'core'
          when bool_or(built) or bool_or(kinds && ${sql.param(builtKinds)}::knowledge_kind[]) then 'built'
          else 'tagged'
        end::topic_role as role
      from (
        select topic, repo_id, case when strict then '{}' else kinds end as kinds, false as core, false as built,
          named and not strict as home
        from tagged
        union all
        select topic, repo_id, null, core, built, false from faceted
        union all
        select topic, home, null, false, false, true from subjects_of where home is not null
      ) found
      where repo_id not in (select repo_id from dead)
      group by topic, repo_id
    ),
    wanted as (
      select r.topic, r.repo_id, r.role from roles r
      where (r.topic, r.repo_id) not in (
        select * from unnest(${textArray(excluded.map(([topic]) => topic))}, ${sql.param(excluded.map(([, id]) => id))}::bigint[])
      )
    ),
    removed as (
      delete from ${topicRepos} m using names n
      where m.topic = n.topic and not exists (select from wanted w where w.topic = m.topic and w.repo_id = m.repo_id)
    ),
    written as (
      insert into ${topicRepos} (topic, repo_id, role) select topic, repo_id, role from wanted
      on conflict (topic, repo_id) do update set role = excluded.role where topic_repos.role <> excluded.role
    )
    select count(*)::int as count from wanted`;
};

// The topics with enough ranked core repos get a page, with their most starred core and built repos by synced
// developers, ties by GitHub stars. Built repos show only when enough rank. Of the repos that may be a topic's home, the
// one most developers star is, once at least as many as rank a repo.
const list = sql`
  with fans as (
    select repo_id, count(*)::int as devs from ${stars}
    where unstarred_at is null group by repo_id having count(*) >= ${topicRule.devs}
  ),
  listed as (
    select m.topic, m.repo_id, m.role, f.devs, coalesce(x.stars, 0) as stars
    from ${topicRepos} m join fans f on f.repo_id = m.repo_id left join ${repoMetrics} x on x.repo_id = m.repo_id
    where m.role in ('core', 'built', 'home')
  ),
  gated as (
    select topic, count(*)::int as ranked from listed where role = 'core'
    group by topic having count(*) >= ${topicRule.gate}
  ),
  placed as (
    select l.topic, l.role, l.repo_id,
      row_number() over (partition by l.topic, l.role order by l.devs desc, l.stars desc, l.repo_id) as place
    from listed l join gated g on g.topic = l.topic
  ),
  lists as (
    select topic,
      coalesce(jsonb_agg(repo_id order by place) filter (where role = 'core' and place <= ${topicRule.core}), '[]') as core,
      case when count(*) filter (where role = 'built') >= ${topicRule.builtAtLeast}
        then jsonb_agg(repo_id order by place) filter (where role = 'built' and place <= ${topicRule.built})
        else '[]'::jsonb end as built
    from placed group by topic
  ),
  sized as (
    select m.topic, count(*)::int as repos from ${topicRepos} m join gated g on g.topic = m.topic group by m.topic
  ),
  homes as (
    select distinct on (l.topic) l.topic, l.repo_id as home
    from listed l join gated g on g.topic = l.topic
    where l.role = 'home'
    order by l.topic, l.devs desc, l.stars desc, l.repo_id
  ),
  dropped as (
    delete from ${topics} where topic not in (select topic from gated)
  ),
  kept as (
    insert into ${topics} (topic, repos, ranked, home, core, built)
    select g.topic, s.repos, g.ranked, h.home, l.core, l.built
    from gated g join sized s on s.topic = g.topic join lists l on l.topic = g.topic left join homes h on h.topic = g.topic
    on conflict (topic) do update set
      repos = excluded.repos, ranked = excluded.ranked, home = excluded.home, core = excluded.core, built = excluded.built
    where (topics.repos, topics.ranked, topics.home, topics.core, topics.built)
      is distinct from (excluded.repos, excluded.ranked, excluded.home, excluded.core, excluded.built)
  )
  select count(*)::int as count from gated`;

const listedCore = sql`
  select m.topic, m.repo_id from ${topicRepos} m join ${topics} t on t.topic = m.topic where m.role = 'core'`;

// Sets a column of every listed topic from a query of (topic, value) rows, `none` for a topic it has no row for.
const setEach = (column: string, none: SQL, ranked: SQL) => sql`
  with ranked as (${ranked}),
  updated as (
    update ${topics} t set ${sql.identifier(column)} = coalesce(r.value, ${none})
    from ${topics} l left join ranked r on r.topic = l.topic
    where t.topic = l.topic and t.${sql.identifier(column)} is distinct from coalesce(r.value, ${none})
    returning 1
  )
  select count(*)::int as count from updated`;

const noList = sql`'[]'::jsonb`;

// The gated topics whose core repos overlap each one's most, by the cosine of the two sets.
const relate = setEach(
  "related",
  noList,
  sql`
    with core as (${listedCore}),
    sizes as (select topic, count(*) as n from core group by topic),
    pairs as (
      select a.topic, b.topic as other, count(*) as shared
      from core a join core b on b.repo_id = a.repo_id and b.topic <> a.topic
      group by a.topic, b.topic having count(*) >= ${topicRule.relatedShared}
    ),
    placed as (
      select p.topic, p.other,
        row_number() over (partition by p.topic order by p.shared / sqrt(sa.n * sb.n) desc, p.other) as place
      from pairs p join sizes sa on sa.topic = p.topic join sizes sb on sb.topic = p.other
    )
    select topic, jsonb_agg(other order by place) as value from placed
    where place <= ${topicRule.related} group by topic`,
);

// The listed people who star at least a few of each topic's core repos, by how many for how many they star, so one who
// stars everything does not lead. A topic shows them only when enough qualify.
const findPeople = setEach(
  "people",
  noList,
  sql`
    with core as (${listedCore}),
    counted as (
      select c.topic, ps.account_id, count(*)::int as n
      from core c join ${peopleStars} ps on ps.repo_id = c.repo_id
      group by c.topic, ps.account_id having count(*) >= ${topicRule.peopleAtLeast}
    ),
    placed as (
      select c.topic, c.account_id, c.n, count(*) over (partition by c.topic) as qualified,
        row_number() over (partition by c.topic order by c.n / sqrt(p.stars) desc, c.account_id) as place
      from counted c join ${people} p on p.account_id = c.account_id
    )
    select topic, jsonb_agg(jsonb_build_array(account_id, n) order by place) as value from placed
    where place <= ${topicRule.people} and qualified >= ${topicRule.peopleAtLeast} group by topic`,
);

// The synced developers into each listed topic. Every current star of a core repo is a row here, about 18 million on
// prod in 2026-11, so this reads stars whole: 17 s on prod, under the long statement limit.
const countDevs = setEach(
  "devs",
  sql`0`,
  sql`
    with core as (${listedCore}),
    fans as (
      select c.topic from core c join ${stars} s on s.repo_id = c.repo_id
      where s.unstarred_at is null
      group by c.topic, s.account_id having count(*) >= ${topicRule.into}
    )
    select topic, count(*)::int as value from fans group by topic`,
);

// Logs how long a step of the refresh took, so a step nearing the long statement limit shows before it fails.
const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.timed(effect).pipe(
    Effect.tap(([took]) => Effect.logInfo("Topics refresh step", { step: name, millis: Duration.toMillis(took) })),
    Effect.map(([, result]) => result),
  );

const like = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const make = Effect.gen(function* () {
  const { run, withLongTimeout } = yield* Postgres.Postgres;
  const { query } = statements(run);
  const long = (operation: Operation, statement: SQL) =>
    withLongTimeout(query(operation, decodeCount, statement)).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  // The listed repos in the order the IDs give, gone and archived ones left out until the next refresh drops them.
  const listedRepos = (ids: ReadonlyArray<number>) =>
    ids.length === 0
      ? Effect.succeed(new Map<number, TopicRepo>())
      : run("topics.page", (db) =>
          db
            .select({
              id: repos.id,
              repo: repoColumns,
              gone: sql<boolean>`${repos.goneAt} is not null`,
              devs: repos.syncedStargazers,
              stars: repoMetrics.stars,
            })
            .from(repos)
            .leftJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
            .where(inArray(repos.id, ids as Array<RepoId>)),
        ).pipe(
          Effect.flatMap(decodeRepos("topics.page")),
          Effect.map(
            (found) =>
              new Map(
                found
                  .filter(({ repo, gone }) => !gone && !repo.archived)
                  .map(({ id, repo, devs, stars }) => [id, { repo, devs, stars }] as const),
              ),
          ),
        );

  // The listed page each typed name means, for the names that have one.
  const pages = (typed: ReadonlyArray<string>) =>
    typed.length === 0
      ? Effect.succeed([])
      : query(
          "topics.resolve",
          decodePages,
          sql`
            select distinct on (n.typed) n.typed as topic, t.topic as page
            from unnest(${textArray(typed)}, ${textArray(typed.map(canonicalTopic))}) as n (typed, canonical)
            join ${topics} t on replace(t.topic, '-', '') = replace(n.canonical, '-', '')
            order by n.typed, t.topic = n.canonical desc, t.ranked desc`,
        );

  return {
    refresh: Effect.fn("Db.topics.refresh")(function* () {
      const spelled = yield* step(
        "considered",
        withLongTimeout(query("topics.considered", decodeSpellings, considered)),
      );
      const names = [...new Set(spelled.map(({ topic }) => topic))];
      let read = 0;
      for (const chunk of chunks(names, topicRule.chunk)) {
        const named = new Set(chunk);
        read += yield* step(
          "members",
          long("topics.members", members(spelled.filter(({ topic }) => named.has(topic)))),
        );
      }
      yield* step(
        "pruned",
        withLongTimeout(
          run("topics.members", (db) =>
            db.execute(sql`delete from ${topicRepos} where topic <> all(${textArray(names)})`),
          ),
        ),
      );
      const listed = yield* step("listed", long("topics.list", list));
      yield* step("related", long("topics.related", relate));
      yield* step("people", long("topics.people", findPeople));
      yield* step("devs", long("topics.devs", countDevs));
      return { considered: names.length, members: read, listed };
    }),

    page: Effect.fn("Db.topics.page")(function* (topic) {
      const [row] = yield* query(
        "topics.page",
        decodeTopicRows,
        sql`
          select t.topic, t.repos, t.ranked, t.devs, t.home::float8 as home, t.core, t.built,
            coalesce((
              select jsonb_agg(
                jsonb_build_object('topic', o.topic, 'repos', o.repos, 'ranked', o.ranked, 'devs', o.devs,
                  'home', ${homeObject})
                order by r.place)
              from jsonb_array_elements_text(t.related) with ordinality as r (topic, place)
              join ${topics} o on o.topic = r.topic
              ${homeJoin(sql`o`)}
            ), '[]'::jsonb) as related
          from ${topics} t where t.topic = ${topic}`,
      );
      if (row === undefined) return Option.none();
      const [found, faces] = yield* Effect.all(
        [
          listedRepos([...(row.home === null ? [] : [row.home]), ...row.core, ...row.built]),
          query(
            "topics.page",
            decodePeople,
            sql`
              select a.login, a.avatar_url as "avatarUrl", (e.pair->>1)::int as repos, p.stars
              from ${topics} t
              cross join lateral jsonb_array_elements(t.people) with ordinality as e (pair, place)
              join ${people} p on p.account_id = (e.pair->>0)::bigint
              join ${githubAccounts} a on a.id = p.account_id
              where t.topic = ${topic}
              order by e.place`,
          ),
        ],
        { concurrency: 2 },
      );
      const pick = (ids: ReadonlyArray<number>) => ids.flatMap((id) => found.get(id) ?? []);
      return Option.some({
        topic: row.topic,
        repos: row.repos,
        ranked: row.ranked,
        devs: row.devs,
        home: Option.fromNullishOr(row.home === null ? undefined : found.get(row.home)),
        core: pick(row.core),
        built: pick(row.built),
        related: row.related,
        people: faces,
      });
    }),

    pages,

    resolve: (typed) =>
      pages([typed]).pipe(Effect.map((found) => Option.map(Option.fromNullishOr(found[0]), ({ page }) => page))),

    size: (topic) =>
      query("topics.size", decodeSize, sql`select repos from ${topics} where topic = ${topic}`).pipe(
        Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.repos)),
      ),

    list: Effect.fn("Db.topics.list")(function* ({ q, offset, limit }) {
      const text = like(q.trim().toLowerCase());
      const rows = yield* query(
        "topics.list",
        decodeTopicCounts,
        sql`
          select p.topic, p.repos, p.ranked, p.devs, ${homeObject} as home, p.total
          from (
            select topic, repos, ranked, devs, home, ${text === "" ? sql`false` : sql`topic like ${`${text}%`}`} as starts,
              count(*) over ()::int as total
            from ${topics}
            where ${text === "" ? sql`true` : sql`topic like ${`%${text}%`}`}
            order by starts desc, ranked desc, topic
            limit ${limit} offset ${offset}
          ) p ${homeJoin(sql`p`)}
          order by p.starts desc, p.ranked desc, p.topic`,
      );
      return { topics: rows.map(({ total: _, ...count }) => count), total: rows[0]?.total ?? 0 };
    }),
  } satisfies Queries;
});
