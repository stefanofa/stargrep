import "@orpc/effect/extensions/schema";
import "@orpc/openapi/extensions/route";
import { type AnyContractProcedure, oc } from "@orpc/contract";
import { mcp } from "@orpc/mcp";
import { SelectionKey } from "@stargrep/knowledge/atom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { errors } from "./errors.ts";
import { GitHubLogin } from "./login.ts";

export { GitHubLogin };

const Timestamp = Schema.String.annotate({ description: "An ISO 8601 time in UTC." });

export const RepoId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("RepoId"));
export const OwnerType = Schema.Literals(["user", "org"]);
export const IconPlate = Schema.Literals(["light", "dark", "none"]);
export const maxIconSize = 128;
export const PlanSource = Schema.Literals(["keyword", "cache", "model", "fallback"]);
const MetricFamily = Schema.Literals([
  "stars",
  "forks",
  "commits",
  "active_contributors",
  "new_contributors",
  "merged_pull_requests",
  "closed_issues",
  "releases",
]);
export const MetricId = Schema.TemplateLiteral([MetricFamily, Schema.Literals(["", "_30d", "_90d", "_growth_90d"])]);

// A filter compiles to one predicate per atom inside the search statement, so its size is bounded like the groups the
// query's own words can make.
export const maxFilterGroups = 8;
export const maxFilterAtoms = 8;

// A GitHub topic, such as nextjs. GitHub keeps topics in lowercase letters, digits, and hyphens, and an address may
// carry a spelling such as next.js that leads to one.
export const TopicName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.+#-]{0,49}$/)).annotate({
  description:
    "A GitHub topic in lowercase, such as 'nextjs'. Another spelling, such as 'next-js', means the same topic.",
});

export const SearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)).annotate({
    description: "What to look for, in plain language, such as 'rust library for terminal dashboards'.",
  }),
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stars"), login: GitHubLogin }),
    Schema.Struct({ kind: Schema.Literal("topic"), topic: TopicName }),
  ]).annotate({
    description:
      "What to search: stars, a login's own stars, or topic, every repo of a GitHub topic that has a page on Stargrep. listTopics names those.",
  }),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
    .annotate({ description: "How many repos to return, at most. 20 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
  filter: Schema.optionalKey(
    SelectionKey.check(
      Schema.makeFilter(
        (selection) =>
          selection.all.length <= maxFilterGroups && selection.all.every((group) => group.any.length <= maxFilterAtoms),
        { expected: `at most ${maxFilterGroups} groups of at most ${maxFilterAtoms} atoms each` },
      ),
    ).annotate({
      description: `Atoms every result must match, such as 'lang:rust subject:4127 subject:812|subject:9031 -kind:list'. Spaces separate groups that must all match, '|' separates atoms of which one must match, and a leading '-' excludes a group. At most ${maxFilterGroups} groups of at most ${maxFilterAtoms} atoms each. lookupFacets finds the atom for a name. A subject that does not exist, is private, or was rejected fails the search with BAD_REQUEST.`,
    }),
  ),
});

const AtomText = Schema.String.annotate({
  description: "An atom's key, such as 'lang:rust', 'about:subject:4127', or 'alt:subject:77'. It works as a filter.",
});

export const Facet = Schema.Struct({
  atom: AtomText,
  label: Schema.String,
  listed: Schema.Boolean.annotate({
    description:
      "False for a subject fewer than two repos hold. Library atoms and lookupFacets leave such a subject out, and a filter by it still works.",
  }),
  repoId: Schema.NullOr(RepoId).annotate({
    description: "The repo a subject is the project of, or null.",
  }),
});

const Icon = Schema.Struct({
  url: Schema.String.annotate({
    description: "A square WebP or SVG on this API's origin, served as immutable, so the URL never shows other bytes.",
  }),
  plate: IconPlate.annotate({
    description:
      "The tile to draw behind the icon. dark for white ink on transparent, light for black ink on transparent.",
  }),
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxIconSize })).annotate({
    description: `The icon's width and height in pixels, at most ${maxIconSize}. Smaller when the source was smaller.`,
  }),
});

const repoFields = {
  id: RepoId,
  owner: Schema.String,
  name: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  license: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String).annotate({
    description: "The repo's primary kind, such as library or cli, or null when Stargrep has not placed it.",
  }),
  archived: Schema.Boolean,
  pushedAt: Schema.NullOr(Timestamp),
  icon: Schema.NullOr(Icon).annotate({
    description: "The repo's own icon, or null when Stargrep found none or has not looked yet.",
  }),
  ownerType: Schema.NullOr(OwnerType).annotate({
    description: "Whether a user or an org owns the repo, or null before Stargrep has read it.",
  }),
  ownerAvatarUrl: Schema.NullOr(Schema.String).annotate({
    description: "The owner's GitHub avatar, or null before Stargrep has read it.",
  }),
};

export const RepoFields = Schema.Struct({
  ...repoFields,
  facets: Schema.Array(Facet).annotate({
    description: "Every atom the repo holds, grouped by role, with its primary kind first.",
  }),
});

export const SearchResult = Schema.Struct({
  ...RepoFields.fields,
  reason: Schema.String.annotate({
    description: "Why the repo matched, such as 'keyword match #2, +38% contributors in 90 days'.",
  }),
  rankedBy: Schema.Array(Schema.String).annotate({
    description: "The values that ranked the repo, such as '+38% contributors in 90 days'.",
  }),
  metrics: Schema.Array(Schema.Struct({ metric: MetricId, value: Schema.NullOr(Schema.Finite) })),
});

export const AppliedAtom = Schema.Struct({
  atom: AtomText,
  label: Schema.String,
  mode: Schema.Literals(["filter", "exclude", "boost"]).annotate({
    description:
      "filter kept only repos that match, exclude dropped repos that match, and boost ranked repos that match higher without dropping any.",
  }),
  from: Schema.Literals(["query", "filter"]).annotate({
    description: "query when the words of q named the atom, filter when the caller's filter did.",
  }),
  span: Schema.NullOr(Schema.Tuple([Schema.Int, Schema.Int])).annotate({
    description:
      "The start and end of the words that named the atom, as character offsets into q trimmed with its runs of spaces collapsed, or null.",
  }),
  relaxed: Schema.Boolean.annotate({
    description:
      "True when the words implied a filter that left fewer than 3 repos, so the search ranked the repos it matches first instead of dropping the others. A filter the caller passed never relaxes.",
  }),
});

export const SearchOutput = Schema.Struct({
  planSource: PlanSource.annotate({
    description:
      "How the query was read. keyword searched the words as typed, and cache and model used a query plan. fallback means the planner failed or the model allowance ran out. The search then ran the words as typed when it had no plan, and full text alone, without search by meaning, when it could not embed the query.",
  }),
  results: Schema.Array(SearchResult),
  applied: Schema.Array(AppliedAtom).annotate({
    description:
      "The atoms the search applied, from the caller's filter and from the words of q. Words Stargrep could not read as an atom with certainty apply nothing and still match by text and meaning.",
  }),
});

export const SyncInput = Schema.Struct({ login: GitHubLogin });

export const EnrichmentProgress = Schema.Struct({
  total: Schema.Int.annotate({ description: "How many repos the login stars now." }),
  read: Schema.Int.annotate({
    description:
      "How many of them Stargrep has summarized and embedded, so search by meaning can find them. Repos are shared, so this can start above zero.",
  }),
  failed: Schema.Int.annotate({
    description:
      "How many of them Stargrep gave up reading after repeated failures of their own, such as repos GitHub no longer serves.",
  }),
  queued: Schema.Int.annotate({
    description:
      "How many of the unread ones wait for a summary, because the daily summary cap deferred it or because Stargrep summarizes a repo only once it is popular enough or a signed-in user stars it. Stargrep reads them later on its own, possibly days later, and search finds them by name and description meanwhile.",
  }),
}).annotate({
  description:
    "How far reading the login's stars has got. Reading is settled for now when state is not queued and read plus failed plus queued equals total, and finished once queued is 0 too. Right after triggerSync the total is still 0, so poll while state is queued or read plus failed plus queued is less than total, poll slowly while only queued repos remain, and reload the library when read changes.",
});

const syncFields = {
  login: Schema.String,
  starredTotal: Schema.NullOr(Schema.Int).annotate({
    description:
      "How many repos the login has starred on GitHub, as of Stargrep's latest look. Null until Stargrep has looked. 0 for an org.",
  }),
  accountType: Schema.NullOr(OwnerType).annotate({
    description: "Whether the login is a user or an org, or null until Stargrep has looked. An org cannot star repos.",
  }),
  enrichment: EnrichmentProgress,
};

export const SyncStatus = Schema.Union([
  Schema.Struct({
    ...syncFields,
    state: Schema.Literals(["unknown", "missing"]),
    requestedAt: Schema.Null,
    syncedAt: Schema.Null,
    waiting: Schema.Null,
  }),
  Schema.Struct({
    ...syncFields,
    state: Schema.Literal("waiting"),
    requestedAt: Timestamp,
    syncedAt: Schema.NullOr(Timestamp),
    waiting: Schema.Struct({
      ahead: Schema.Int.annotate({ description: "How many syncs waiting in line start before this one." }),
      startsAt: Timestamp.annotate({ description: "When this sync is due to start. An estimate that can move later." }),
    }),
  }),
  Schema.Struct({
    ...syncFields,
    state: Schema.Literal("queued"),
    requestedAt: Timestamp,
    syncedAt: Schema.NullOr(Timestamp),
    waiting: Schema.Null,
  }),
  Schema.Struct({
    ...syncFields,
    state: Schema.Literal("failed"),
    requestedAt: Timestamp,
    syncedAt: Schema.NullOr(Timestamp),
    waiting: Schema.Null,
  }),
  Schema.Struct({
    ...syncFields,
    state: Schema.Literal("done"),
    requestedAt: Schema.Null,
    syncedAt: Timestamp,
    waiting: Schema.Null,
  }),
]).annotate({
  description:
    "unknown has never synced, missing is a login GitHub did not have when Stargrep looked in the last 10 minutes, so triggerSync answers LOGIN_NOT_FOUND, waiting has a place in line, queued is about to run or running, failed could not finish, and done has a sync time.",
});

export const RepoInput = Schema.Struct({ id: RepoId.annotate({ description: "The GitHub repo ID." }) });

export const RepoDetail = Schema.Struct({
  ...RepoFields.fields,
  keywords: Schema.Array(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Timestamp),
});

// How many repos each row of similarRepos holds, at most.
export const similarLimit = 5;

export const SimilarInput = Schema.Struct({
  id: RepoId.annotate({ description: "The GitHub repo ID to find repos like." }),
  login: GitHubLogin.annotate({
    description: "Whose stars inStars looks in and notStarred leaves out. The login must be synced first.",
  }),
});

const SimilarRepo = Schema.Struct({
  ...repoFields,
  stars: Schema.NullOr(Schema.Int).annotate({ description: "The repo's star count, when Stargrep has read it." }),
});

// How many people similarRepos' starredBy names, at most.
export const starredByLimit = 6;

export const SimilarRepos = Schema.Struct({
  starredBy: Schema.Struct({
    people: Schema.Array(
      Schema.Struct({
        login: Schema.String,
        avatarUrl: Schema.NullOr(Schema.String).annotate({
          description: "The account's GitHub avatar, or null before Stargrep has read it.",
        }),
      }),
    ).annotate({
      description: `Up to ${starredByLimit} of them, the config's curated accounts first, then the most followed.`,
    }),
    total: Schema.Int.annotate({ description: "How many people on the list star the repo." }),
  }).annotate({
    description: "The people on the people list who star the repo now, as of the nightly refresh, the login left out.",
  }),
  inStars: Schema.Array(SimilarRepo).annotate({
    description: `Up to ${similarLimit} of the login's own stars nearest the repo by meaning, nearest first, the repo itself left out.`,
  }),
  notStarred: Schema.Array(SimilarRepo).annotate({
    description: `Up to ${similarLimit} repos across Stargrep nearest the repo by meaning that the login hasn't starred, nearest first. Only repos Stargrep has summarized, leaving out archived repos and repos GitHub no longer serves.`,
  }),
}).annotate({ description: "inStars and notStarred are empty when Stargrep has no embedding of the repo yet." });

export const Viewer = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  starredCount: Schema.NullOr(Schema.Int).annotate({
    description: "How many repos the account had starred on GitHub when it last signed in.",
  }),
});

export const MonthlyPicks = Schema.Struct({
  optedIn: Schema.Boolean.annotate({
    description: "Whether the signed-in account asked for a monthly email of repos picked from its stars.",
  }),
});

export const LibraryRepo = Schema.Struct({
  ...repoFields,
  atoms: Schema.Array(AtomText).annotate({
    description:
      "The keys whose filter matches the repo, such as lang:javascript on a TypeScript repo, so counting them gives the number of repos each filter returns. A subject appears once two repos hold it. labels names each key.",
  }),
  keywords: Schema.Array(Schema.String),
  starredAt: Timestamp,
  stars: Schema.NullOr(Schema.Int).annotate({ description: "The repo's star count, when Stargrep has read it." }),
  read: Schema.Boolean.annotate({
    description: "Whether Stargrep has summarized and embedded the repo, so search by meaning can find it.",
  }),
  gone: Schema.Boolean.annotate({ description: "Whether GitHub stopped serving the repo publicly." }),
});

const Labels = Schema.Record(Schema.String, Schema.String).annotate({
  description: "The label of every atom key the repos list, such as 'lang:rust': 'Rust'.",
});

export const Library = Schema.Struct({ repos: Schema.Array(LibraryRepo), labels: Labels });

export const maxStarsPage = 1000;

const StarsCursorText = Schema.String.check(Schema.isPattern(/^\d{1,15}-\d{1,15}$/)).annotate({
  description: "Where a page of stars continues, from nextCursor.",
});

// The time and repo ID of the last star a page answered, written as "<millis>-<repoId>".
export const StarsCursor = StarsCursorText.pipe(
  Schema.decodeTo(
    Schema.Struct({ starredAt: Schema.DateTimeUtcFromMillis, repoId: RepoId }),
    SchemaTransformation.transform({
      decode: (cursor) => {
        const [starredAt = Number.NaN, repoId = Number.NaN] = cursor.split("-").map(Number);
        return { starredAt, repoId };
      },
      encode: ({ starredAt, repoId }) => `${starredAt}-${repoId}`,
    }),
  ),
);

export const StarsInput = Schema.Struct({
  login: GitHubLogin,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxStarsPage }))
    .annotate({ description: `How many repos to return, at most. ${maxStarsPage} when left out.` })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(maxStarsPage))),
  cursor: Schema.optionalKey(StarsCursor),
});

export const PublicStars = Schema.Struct({
  login: Schema.String,
  repos: Schema.Array(LibraryRepo).annotate({ description: "The login's stars, newest first." }),
  nextCursor: Schema.NullOr(StarsCursorText).annotate({
    description: "Pass as cursor to read the next page, or null when this page is the last.",
  }),
  cursors: Schema.optionalKey(Schema.Array(StarsCursorText)).annotate({
    description:
      "On a first page read at a limit of 100 or 1000, the cursor of every later page in order, so a client can read them all at once with the same limit.",
  }),
  labels: Labels,
});

export const StarLanguages = Schema.Struct({
  login: Schema.String,
  total: Schema.Int.annotate({ description: "How many repos the login stars now, with or without a language." }),
  languages: Schema.Array(Schema.Struct({ language: Schema.String, count: Schema.Int })).annotate({
    description:
      "How many of the login's stars each language GitHub names holds, most first. Repos with no language count only toward total.",
  }),
});

export const maxNewToYou = 48;

export const NewToYouInput = Schema.Struct({
  login: GitHubLogin.annotate({ description: "Whose stars to compare with the signed-in account's." }),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxNewToYou }))
    .annotate({ description: `How many repos to return, at most. 8 when left out.` })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(8))),
});

export const NewToYou = Schema.Struct({
  shared: Schema.NullOr(Schema.Int).annotate({
    description: "How many repos both accounts star now, or null until the signed-in account's stars have synced.",
  }),
  repos: Schema.Array(LibraryRepo).annotate({
    description:
      "Repos the login stars that the signed-in account does not, closest to the signed-in account's own stars first. Archived repos and repos GitHub no longer serves are left out.",
  }),
  labels: Labels,
});

export const LookupInput = Schema.Struct({
  q: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100)).annotate({
    description: "The start of a facet's name, such as 'postg'.",
  }),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
    .annotate({ description: "How many facets to return, at most. 10 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
});

export const FacetMatches = Schema.Struct({
  facets: Schema.Array(
    Schema.Struct({
      atom: AtomText,
      label: Schema.String,
      repos: Schema.Int.annotate({
        description: "How many repos the atom's filter matches across Stargrep, from the last nightly count.",
      }),
    }),
  ).annotate({ description: "Most-held first." }),
});

export const PublicConfig = Schema.Struct({
  demoLogin: GitHubLogin.annotate({
    description: "The account whose stars the home page searches before anyone picks one.",
  }),
  demoQuery: Schema.String.annotate({ description: "The query the home page answers before anyone types one." }),
  examples: Schema.Array(Schema.String).annotate({ description: "More queries that suit the demo account's stars." }),
  featured: Schema.Array(GitHubLogin).annotate({
    description: "Accounts to offer when someone picks whose stars to search.",
  }),
  curated: Schema.Array(GitHubLogin).annotate({
    description:
      "A short pick of well-known accounts to show first. Each is on the people list whatever its rule says, once its stars are synced.",
  }),
});
export type PublicConfig = typeof PublicConfig.Type;

export const maxPeoplePage = 100;
export const maxPeopleOffset = 10_000;

export const PeopleSort = Schema.Literals(["recently-active", "most-like-you"]);

export const PeopleInput = Schema.Struct({
  sort: PeopleSort.annotate({
    description:
      "recently-active puts the latest star first. most-like-you puts first the people who share the most stars with the signed-in account for how many they star, and sorts as recently-active for anyone else. recently-active when left out.",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("recently-active" as const))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxPeoplePage }))
    .annotate({ description: `How many people to return, at most. 24 when left out.` })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(24))),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxPeopleOffset }))
    .annotate({ description: "How many people to skip, from nextOffset. 0 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});

const personFields = {
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String).annotate({
    description: "The account's GitHub avatar, or null before Stargrep has read it.",
  }),
  curated: Schema.Boolean.annotate({ description: "Whether the account is one of the config's curated accounts." }),
  stars: Schema.Int.annotate({ description: "How many repos the account stars now, as Stargrep last synced them." }),
  lastStarredAt: Timestamp.annotate({ description: "When the account starred its newest repo." }),
  languages: Schema.Array(
    Schema.Struct({
      language: Schema.String,
      share: Schema.Finite.annotate({ description: "The share of the account's stars in this language, from 0 to 1." }),
    }),
  ).annotate({ description: "Up to 3 languages most of the account's stars are written in, most first." }),
  topics: Schema.Array(Schema.String).annotate({
    description: "Up to 3 GitHub topics most of the account's stars carry, most first.",
  }),
};

export const Person = Schema.Struct({
  ...personFields,
  shared: Schema.NullOr(Schema.Int).annotate({
    description:
      "How many repos the account and the signed-in account both star, or null when no one is signed in or the signed-in account's stars have not synced yet.",
  }),
});

export const People = Schema.Struct({
  sort: PeopleSort.annotate({ description: "The order the people come in." }),
  people: Schema.Array(Person),
  total: Schema.Int.annotate({ description: "How many people the list holds." }),
  nextOffset: Schema.NullOr(Schema.Int).annotate({
    description: "Pass as offset to read the next page, or null when this page is the last.",
  }),
}).annotate({
  description:
    "Users with at least 5,000 followers and 40 current stars who starred something in the last 90 days, plus the curated accounts, as of the nightly refresh. A signed-in account is left out of its own list.",
});

export const maxSimilarPeople = 12;

export const SimilarPeopleInput = Schema.Struct({
  login: GitHubLogin.annotate({
    description: "Whose stars to compare with the people list's. The login must be synced first.",
  }),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxSimilarPeople }))
    .annotate({ description: "How many people to return, at most. 3 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
});

export const SimilarPeople = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      ...personFields,
      shared: Schema.Int.annotate({ description: "How many repos the person and the login both star." }),
    }),
  ).annotate({
    description:
      "The people on the list who share the most stars with the login for how many they star, most alike first. The login itself and anyone who shares none are left out.",
  }),
});

export const maxTopicsPage = 200;

export const TopicsInput = Schema.Struct({
  q: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(50)).annotate({
      description: "Text the topic's name holds, such as 'react'. Every topic when left out.",
    }),
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxTopicsPage }))
    .annotate({ description: "How many topics to return, at most. 60 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
    .annotate({ description: "How many topics to skip, from nextOffset. 0 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});

const topicCountFields = {
  topic: Schema.String,
  repos: Schema.Int.annotate({ description: "How many repos the topic's search reads." }),
  ranked: Schema.Int.annotate({
    description: "How many repos for or about the topic at least 3 of the developers Stargrep synced star.",
  }),
  icon: Schema.NullOr(Icon).annotate({
    description: "The topic's logo, or its own repo's icon, or null when it has neither.",
  }),
};

export const Topics = Schema.Struct({
  topics: Schema.Array(Schema.Struct(topicCountFields)).annotate({
    description: "Most ranked repos first. With q, the names that start with it come first.",
  }),
  total: Schema.Int.annotate({ description: "How many topics match." }),
  nextOffset: Schema.NullOr(Schema.Int).annotate({
    description: "Pass as offset to read the next page, or null when this page is the last.",
  }),
}).annotate({ description: "The GitHub topics that have a page, as of the nightly refresh." });

export const TopicInput = Schema.Struct({ topic: TopicName });

const TopicRepo = Schema.Struct({
  ...repoFields,
  devs: Schema.Int.annotate({ description: "How many of the developers Stargrep synced star the repo." }),
  stars: Schema.NullOr(Schema.Int).annotate({ description: "GitHub's star count, or null before Stargrep read it." }),
});

export const Topic = Schema.Struct({
  ...topicCountFields,
  topic: TopicName.annotate({ description: "The topic's own spelling, which may differ from the one asked for." }),
  home: Schema.NullOr(TopicRepo).annotate({ description: "The topic's own repo, such as vercel/next.js for nextjs." }),
  core: Schema.Array(TopicRepo).annotate({
    description: "Repos for or about the topic, most starred by synced developers first. The home repo is left out.",
  }),
  built: Schema.Array(TopicRepo).annotate({
    description: "Apps built with the topic, most starred by synced developers first. Empty unless at least 6 rank.",
  }),
  related: Schema.Array(Schema.Struct(topicCountFields)).annotate({
    description: "Topics whose repos overlap this one's the most, closest first.",
  }),
  people: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      avatarUrl: Schema.NullOr(Schema.String),
      repos: Schema.Int.annotate({ description: "How many of the topic's repos the person stars." }),
      stars: Schema.Int.annotate({ description: "How many repos the person stars in all." }),
    }),
  ).annotate({
    description:
      "People on the people list who star the most of the topic's repos for how many they star. Empty unless at least 5 qualify.",
  }),
});

export const maxTopicPages = 50;

export const TopicPagesInput = Schema.Struct({
  topics: Schema.Array(Schema.String.check(Schema.isMaxLength(100)))
    .check(Schema.isMaxLength(maxTopicPages))
    .annotate({ description: `GitHub topics as a repo or an account carries them, at most ${maxTopicPages}.` }),
});

export const TopicPages = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      topic: Schema.String.annotate({ description: "A topic as it was asked for." }),
      page: Schema.String.annotate({ description: "The topic whose page it leads to, for the topic's path." }),
    }),
  ).annotate({ description: "One entry for each topic asked for that has a page. Topics without one are left out." }),
});

// How many accounts one person may follow. core's followCap holds the same number.
export const maxFollows = 1000;

export const FollowSource = Schema.Literals(["stargrep", "github"]).annotate({
  description: "github for people copied from the account's GitHub following, stargrep for everyone else.",
});

export const FollowInput = Schema.Struct({
  logins: Schema.Array(GitHubLogin)
    .check(Schema.isMinLength(1), Schema.isMaxLength(maxFollows))
    .annotate({ description: "The GitHub users to follow, such as a topic's people." }),
  source: FollowSource.pipe(Schema.withDecodingDefaultKey(Effect.succeed("stargrep" as const))),
});

export const Followed = Schema.Struct({
  following: Schema.Array(Schema.String).annotate({
    description:
      "The logins asked for that the account follows now, in the order asked. Orgs, the account itself, logins Stargrep doesn't know, and logins past the cap are left out.",
  }),
  total: Schema.Int.annotate({ description: "How many people the account follows now." }),
  full: Schema.Boolean.annotate({
    description: `Whether the cap of ${maxFollows} follows left some of the logins out.`,
  }),
});

export const UnfollowInput = Schema.Struct({ login: GitHubLogin });

export const Unfollowed = Schema.Struct({
  unfollowed: Schema.Boolean.annotate({ description: "Whether the account followed the login until now." }),
});

export const FollowedLogins = Schema.Struct({
  follows: Schema.Array(Schema.Struct({ login: Schema.String, followedAt: Timestamp })).annotate({
    description: "Everyone the account follows and since when, the newest follow first.",
  }),
});

export const FollowedPerson = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  source: FollowSource,
  followedAt: Timestamp,
  lastStarredAt: Schema.NullOr(Timestamp).annotate({
    description: "The person's newest current star Stargrep holds, or null before their stars arrive.",
  }),
  checkedAt: Schema.NullOr(Timestamp).annotate({
    description: "When Stargrep last found the person's stars current, or null while their stars are still arriving.",
  }),
});

export const FollowedPeople = Schema.Struct({
  people: Schema.Array(FollowedPerson).annotate({
    description: "Everyone the account follows, the newest follow first.",
  }),
});

const FeedRepo = Schema.Struct({
  ...repoFields,
  stars: Schema.NullOr(Schema.Int).annotate({ description: "The repo's star count, when Stargrep has read it." }),
  starredBy: Schema.Array(Schema.Struct({ login: Schema.String, starredAt: Timestamp })).annotate({
    description: "The people the account follows who starred the repo in the window, the latest first.",
  }),
});

export const FollowingFeed = Schema.Struct({
  following: Schema.Int.annotate({ description: "How many people the account follows." }),
  arriving: Schema.Int.annotate({ description: "How many of them Stargrep hasn't read the stars of yet." }),
  checkedAt: Schema.NullOr(Timestamp).annotate({
    description: "The oldest time Stargrep last found the stars of someone the account follows current.",
  }),
  windowDays: Schema.Int,
  avatars: Schema.Record(Schema.String, Schema.NullOr(Schema.String)).annotate({
    description: "The avatar of every login the feed names.",
  }),
  repos: Schema.Array(FeedRepo).annotate({
    description:
      "One entry per repo the people the account follows starred in the window, the latest star first, leaving out repos the account stars.",
  }),
  top: Schema.NullOr(Schema.Struct({ id: RepoId, starrers: Schema.Int })).annotate({
    description: "The repo the most of them starred in the last 7 days, when at least 2 did. It is in repos too.",
  }),
  busiest: Schema.Array(Schema.Struct({ login: Schema.String, stars: Schema.Int, latestAt: Timestamp })).annotate({
    description: "Up to 3 of them who starred the most repos in the last 7 days.",
  }),
  lastStar: Schema.NullOr(Schema.Struct({ login: Schema.String, starredAt: Timestamp })).annotate({
    description: "The newest star of anyone the account follows, inside the window or not.",
  }),
});

export const GitHubFollowing = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({ login: Schema.String, avatarUrl: Schema.NullOr(Schema.String), following: Schema.Boolean }),
  ).annotate({
    description:
      "The users the account follows on GitHub whose stars Stargrep holds, the most followed first, with whether the account follows them here.",
  }),
  notOnStargrep: Schema.Int.annotate({ description: "How many other users it follows on GitHub." }),
});

export const FollowedStarrersInput = Schema.Struct({
  id: RepoId.annotate({ description: "The GitHub repo ID." }),
  login: GitHubLogin.annotate({ description: "Whose stars the repo is shown on. That account is left out." }),
});

export const FollowedStarrers = Schema.Struct({
  people: Schema.Array(Schema.Struct({ login: Schema.String, avatarUrl: Schema.NullOr(Schema.String) })).annotate({
    description: `Up to ${starredByLimit} of the people the account follows who star the repo now, the latest star first.`,
  }),
  total: Schema.Int,
});

const sessionRequired = {
  name: "session",
  init: (meta: object) => ({ ...meta, session: "required" }),
};

export const requiresSession = (procedure: AnyContractProcedure) => procedure["~orpc"].meta.session === "required";
export const anyoneCanCall = (procedure: AnyContractProcedure) => !requiresSession(procedure);

const procedure = oc.errors(Struct.pick(errors, ["BAD_REQUEST", "INTERNAL_SERVER_ERROR"]));
const withServices = procedure.errors(Struct.pick(errors, ["SERVICE_UNAVAILABLE"]));

export const contract = {
  // The query goes in the body, so it never lands in a URL, a request log, or the platform's request span.
  search: withServices
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "TOPIC_NOT_FOUND", "TOO_MANY_REQUESTS"]))
    .route({
      method: "POST",
      path: "/search",
      operationId: "search",
      summary: "Search a login's GitHub stars or a topic's repos",
      description:
        "Searches the repos a GitHub login starred, or the repos of a GitHub topic, in plain language, and ranks them by how well they match. The login must be synced first.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(SearchInput)
    .output(SearchOutput),
  triggerSync: withServices
    .errors(Struct.pick(errors, ["LOGIN_NOT_FOUND", "TOO_MANY_REQUESTS", "SYNC_BUSY"]))
    .route({
      method: "POST",
      path: "/sync/{login}",
      successStatus: 202,
      operationId: "triggerSync",
      summary: "Sync a login's GitHub stars",
      description:
        "Checks that the GitHub login exists, queues a sync of its stars, and returns its status. A login synced, queued, or failed in the last 10 minutes is not queued again. When GitHub's budget for new imports is spent, the sync waits in line and the status says when it starts.",
    })
    .input(SyncInput)
    .output(SyncStatus),
  syncStatus: withServices
    .route({
      method: "GET",
      path: "/sync/{login}",
      operationId: "syncStatus",
      summary: "Read a login's sync status",
      description:
        "Says whether a login's stars are synced, queued for a sync, failed to sync, or unknown to Stargrep, and how many of them Stargrep has read.",
    })
    .input(SyncInput)
    .output(SyncStatus),
  getRepo: withServices
    .errors(Struct.pick(errors, ["REPO_NOT_FOUND"]))
    .route({
      method: "GET",
      path: "/repos/{id}",
      operationId: "getRepo",
      summary: "Read one repo",
      description: "Returns what Stargrep knows about a repo, including its summary, by GitHub repo ID.",
    })
    .input(RepoInput)
    .output(RepoDetail),
  similarRepos: withServices
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "REPO_NOT_FOUND", "TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/repos/{id}/similar",
      operationId: "similarRepos",
      summary: "Find repos like one repo",
      description:
        "Returns the repos nearest one repo by meaning, in two lists: those among a login's stars, and those across Stargrep the login hasn't starred. Also names the people on the people list who star the repo.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(SimilarInput)
    .output(SimilarRepos),
  viewer: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/viewer",
      operationId: "viewer",
      summary: "Read the signed-in account",
      description: "Returns the GitHub account of the person signed in with the session cookie.",
    })
    .output(Viewer),
  library: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/library",
      operationId: "library",
      summary: "List the signed-in account's stars",
      description: "Returns every repo the signed-in account starred, newest star first.",
    })
    .output(Library),
  monthlyPicks: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/monthly-picks",
      operationId: "monthlyPicks",
      summary: "Read the monthly picks opt-in",
      description: "Says whether the signed-in account asked for a monthly email of repos picked from its stars.",
    })
    .output(MonthlyPicks),
  setMonthlyPicks: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED"]))
    .meta(sessionRequired)
    .route({
      method: "PUT",
      path: "/monthly-picks",
      operationId: "setMonthlyPicks",
      summary: "Opt in to or out of monthly picks",
      description: "Turns the monthly picks email on or off for the signed-in account. Nothing sends it yet.",
    })
    .input(MonthlyPicks)
    .output(MonthlyPicks),
  follow: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "POST",
      path: "/follows",
      operationId: "follow",
      summary: "Follow GitHub users",
      description:
        "Follows GitHub users whose stars Stargrep knows, so their new stars show in the account's following feed. Follows are private and nobody is told.",
    })
    .input(FollowInput)
    .output(Followed),
  unfollow: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "DELETE",
      path: "/follows/{login}",
      operationId: "unfollow",
      summary: "Unfollow a GitHub user",
      description: "Stops following a GitHub user. Nobody is told.",
    })
    .input(UnfollowInput)
    .output(Unfollowed),
  followedLogins: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/follows",
      operationId: "followedLogins",
      summary: "List whom the signed-in account follows",
      description: "Returns the login of everyone the signed-in account follows and when each follow started.",
    })
    .output(FollowedLogins),
  followedPeople: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/following/people",
      operationId: "followedPeople",
      summary: "List the people the signed-in account follows",
      description: "Returns everyone the signed-in account follows, with their latest star and when it was checked.",
    })
    .output(FollowedPeople),
  followingFeed: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/following/feed",
      operationId: "followingFeed",
      summary: "Read the following feed",
      description:
        "Returns the repos the people the signed-in account follows starred in the last 30 days, one entry per repo, leaving out repos the account stars.",
    })
    .output(FollowingFeed),
  githubFollowing: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/following/github",
      operationId: "githubFollowing",
      summary: "Read the signed-in account's GitHub following",
      description:
        "Reads whom the signed-in account follows on GitHub, with its own token, and returns the ones whose stars Stargrep holds. It reads at most once a day.",
    })
    .output(GitHubFollowing),
  followedStarrers: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/repos/{id}/followed",
      operationId: "followedStarrers",
      summary: "List the people you follow who star a repo",
      description: "Returns the people the signed-in account follows who star the repo now.",
    })
    .input(FollowedStarrersInput)
    .output(FollowedStarrers),
  newToYou: withServices
    .errors(Struct.pick(errors, ["UNAUTHORIZED", "ACCOUNT_NOT_SYNCED", "TOO_MANY_REQUESTS"]))
    .meta(sessionRequired)
    .route({
      method: "GET",
      path: "/new-to-you/{login}",
      operationId: "newToYou",
      summary: "Compare a login's stars with the signed-in account's",
      description:
        "Counts the repos both accounts star and lists the login's stars the signed-in account has not starred, closest to its own stars first.",
    })
    .input(NewToYouInput)
    .output(NewToYou),
  stars: withServices
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/stars/{login}",
      operationId: "stars",
      summary: "List a login's synced stars",
      description:
        "Returns the repos a GitHub login starred that Stargrep has synced, newest star first, a page at a time.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(StarsInput)
    .output(PublicStars),
  starLanguages: withServices
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/stars/{login}/languages",
      operationId: "starLanguages",
      summary: "Count a login's stars by language",
      description: "Counts the repos a GitHub login starred that Stargrep has synced, by each repo's main language.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(SyncInput)
    .output(StarLanguages),
  // The name goes in the body, as search's query does, because it is what someone typed.
  lookupFacets: withServices
    .errors(Struct.pick(errors, ["TOO_MANY_REQUESTS"]))
    .route({
      method: "POST",
      path: "/facets",
      operationId: "lookupFacets",
      summary: "Find atoms by name",
      description:
        "Finds the atoms whose name starts with q, to pass as search's filter: kinds, languages, licenses, platforms, statuses, and subjects that at least two repos hold, most-held first.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(LookupInput)
    .output(FacetMatches),
  people: withServices
    .errors(Struct.pick(errors, ["TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/people",
      operationId: "people",
      summary: "List people whose stars to explore",
      description:
        "Lists well-known GitHub users whose stars Stargrep has synced, with what their stars are about, a page at a time. Signed in, each person also says how many stars they share with you.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(PeopleInput)
    .output(People),
  similarPeople: withServices
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/people/{login}/similar",
      operationId: "similarPeople",
      summary: "Find people with stars like a login's",
      description:
        "Returns the people on the people list whose stars overlap the most with a login's, for how many they star.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(SimilarPeopleInput)
    .output(SimilarPeople),
  listTopics: withServices
    .errors(Struct.pick(errors, ["TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/topics",
      operationId: "listTopics",
      summary: "List GitHub topics with a page",
      description:
        "Lists the GitHub topics Stargrep has a page for, the ones whose repos developers star the most first. Each topic's repos are searchable with search's topic scope.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(TopicsInput)
    .output(Topics),
  topic: withServices
    .errors(Struct.pick(errors, ["TOPIC_NOT_FOUND", "TOO_MANY_REQUESTS"]))
    .route({
      method: "GET",
      path: "/topics/{topic}",
      operationId: "topic",
      summary: "Read a GitHub topic's page",
      description:
        "Returns a GitHub topic's repos ranked by how many synced developers star them, the apps built with it, related topics, and the people who star its repos.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(TopicInput)
    .output(Topic),
  // The topics go in the body, as lookupFacets's name does, since a repo can carry 20.
  topicPages: withServices
    .errors(Struct.pick(errors, ["TOO_MANY_REQUESTS"]))
    .route({
      method: "POST",
      path: "/topics/pages",
      operationId: "topicPages",
      summary: "Find which GitHub topics have a page",
      description:
        "Takes GitHub topics, such as a repo's, and answers the ones Stargrep has a page for, each with the topic its page is under, so next-js leads to nextjs.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .input(TopicPagesInput)
    .output(TopicPages),
  config: procedure
    .route({
      method: "GET",
      path: "/config",
      operationId: "config",
      summary: "Read the public settings",
      description: "Returns the demo account and the queries the home page offers.",
    })
    .meta(mcp.tool({ annotations: { readOnlyHint: true } }))
    .output(PublicConfig),
};
