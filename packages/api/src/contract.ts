import "@orpc/effect/extensions/schema";
import "@orpc/openapi/extensions/route";
import { type AnyContractProcedure, oc } from "@orpc/contract";
import { mcp } from "@orpc/mcp";
import { githubLogin, isGitHubLogin } from "@stargrep/github/login";
import { SelectionKey } from "@stargrep/knowledge/atom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { errors } from "./errors.ts";

export const GitHubLogin = Schema.String.check(
  Schema.makeFilter(isGitHubLogin, {
    expected: "a GitHub login",
    toJsonSchema: () => ({ pattern: githubLogin.source }),
  }),
)
  .pipe(Schema.brand("Login"))
  .annotate({
    description: "A GitHub login, such as octocat.",
  });

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

export const SearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)).annotate({
    description: "What to look for, in plain language, such as 'rust library for terminal dashboards'.",
  }),
  scope: Schema.Struct({ kind: Schema.Literal("stars"), login: GitHubLogin }).annotate({
    description: "Whose stars to search. Only stars, the login's own stars, is available now.",
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
  icon: Schema.NullOr(
    Schema.Struct({
      url: Schema.String.annotate({
        description: "A square WebP on this API's origin, served as immutable, so the URL never shows other bytes.",
      }),
      plate: IconPlate.annotate({
        description:
          "The tile to draw behind the icon. dark for white ink on transparent, light for black ink on transparent.",
      }),
      size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxIconSize })).annotate({
        description: `The icon's width and height in pixels, at most ${maxIconSize}. Smaller when the source was smaller.`,
      }),
    }),
  ).annotate({ description: "The repo's own icon, or null when Stargrep found none or has not looked yet." }),
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
}).annotate({
  description:
    "How far reading the login's stars has got. Reading is finished when state is not queued and read plus failed equals total. Right after triggerSync the total is still 0, so poll while state is queued or read plus failed is less than total, and reload the library when read changes.",
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
    state: Schema.Literal("unknown"),
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
    "unknown has never synced, waiting has a place in line, queued is about to run or running, failed could not finish, and done has a sync time.",
});

export const RepoInput = Schema.Struct({ id: RepoId.annotate({ description: "The GitHub repo ID." }) });

export const RepoDetail = Schema.Struct({
  ...RepoFields.fields,
  keywords: Schema.Array(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Timestamp),
});

export const Viewer = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  starredCount: Schema.NullOr(Schema.Int).annotate({
    description: "How many repos the account had starred on GitHub when it last signed in.",
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
});
export type PublicConfig = typeof PublicConfig.Type;

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
    .errors(Struct.pick(errors, ["ACCOUNT_NOT_SYNCED", "TOO_MANY_REQUESTS"]))
    .route({
      method: "POST",
      path: "/search",
      operationId: "search",
      summary: "Search a login's GitHub stars",
      description:
        "Searches the repos a GitHub login starred, in plain language, and ranks them by how well they match. The login must be synced first.",
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
