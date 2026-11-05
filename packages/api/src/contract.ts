import "@orpc/effect/extensions/schema";
import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { mcp } from "@orpc/mcp";
import { MetricRegistry, QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { Login, RepoId } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { errors } from "./errors.ts";

const GitHubLogin = Login.check(Schema.isPattern(/^[a-z\d][a-z\d-]{0,38}$/i)).annotate({
  description: "A GitHub login, such as octocat.",
});

const Timestamp = Schema.String.annotate({ description: "An ISO 8601 time in UTC." });

export const SearchInput = Schema.Struct({
  login: GitHubLogin,
  q: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)).annotate({
    description: "What to look for, in plain language, such as 'rust library for terminal dashboards'.",
  }),
  scope: Search.ScopeKind.annotate({
    description: "Whose stars to search. Only stars, the login's own stars, is available now.",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("stars" as const))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
    .annotate({ description: "How many repos to return, at most. 20 when left out." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
});

export const RepoFields = Schema.Struct({
  id: RepoId,
  owner: Schema.String,
  name: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  license: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  pushedAt: Schema.NullOr(Timestamp),
  icon: Schema.NullOr(
    Schema.Struct({
      url: Schema.String.annotate({
        description: "A square WebP on this API's origin, served as immutable, so the URL never shows other bytes.",
      }),
      plate: Db.IconPlate.annotate({
        description:
          "The tile to draw behind the icon. dark for white ink on transparent, light for black ink on transparent.",
      }),
      size: Db.RepoIcon.fields.size.annotate({
        description: `The icon's width and height in pixels, at most ${Db.maxIconSize}. Smaller when the source was smaller.`,
      }),
    }),
  ).annotate({ description: "The repo's own icon, or null when Stargrep found none or has not looked yet." }),
  ownerType: Schema.NullOr(Db.OwnerType).annotate({
    description: "Whether a user or an org owns the repo, or null before Stargrep has read it.",
  }),
  ownerAvatarUrl: Schema.NullOr(Schema.String).annotate({
    description: "The owner's GitHub avatar, or null before Stargrep has read it.",
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
  metrics: Schema.Array(Schema.Struct({ metric: MetricRegistry.MetricId, value: Schema.NullOr(Schema.Finite) })),
});

export const SearchOutput = Schema.Struct({
  planSource: QueryPlanner.PlanSource.annotate({
    description:
      "How the query was read. keyword searched the words as typed, cache and model used a query plan, and fallback searched the words as typed because the planner failed.",
  }),
  results: Schema.Array(SearchResult),
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

export const SyncStatus = Schema.Struct({
  login: Schema.String,
  state: SyncRequests.SyncState.annotate({
    description:
      "unknown means Stargrep never synced the login, queued means a sync is waiting or running, failed means the last requested sync could not finish, and done means the stars are synced.",
  }),
  requestedAt: Schema.NullOr(Timestamp),
  syncedAt: Schema.NullOr(Timestamp),
  enrichment: EnrichmentProgress,
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
  ...RepoFields.fields,
  keywords: Schema.Array(Schema.String),
  starredAt: Timestamp,
  stars: Schema.NullOr(Schema.Int).annotate({ description: "The repo's star count, when Stargrep has read it." }),
  read: Schema.Boolean.annotate({
    description: "Whether Stargrep has summarized and embedded the repo, so search by meaning can find it.",
  }),
});

export const Library = Schema.Struct({ repos: Schema.Array(LibraryRepo) });

export const signedIn = new Set(["viewer", "library"]);

const procedure = oc.errors(errors);

export const contract = {
  // The query goes in the body, so it never lands in a URL, a request log, or the platform's request span.
  search: procedure
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
  triggerSync: procedure
    .route({
      method: "POST",
      path: "/sync/{login}",
      successStatus: 202,
      operationId: "triggerSync",
      summary: "Sync a login's GitHub stars",
      description:
        "Queues a sync of the stars of a public GitHub login and returns its status. A login synced, queued, or failed in the last 10 minutes is not queued again.",
    })
    .input(SyncInput)
    .output(SyncStatus),
  syncStatus: procedure
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
  getRepo: procedure
    .route({
      method: "GET",
      path: "/repos/{id}",
      operationId: "getRepo",
      summary: "Read one repo",
      description: "Returns what Stargrep knows about a repo, including its summary, by GitHub repo ID.",
    })
    .input(RepoInput)
    .output(RepoDetail),
  viewer: procedure
    .route({
      method: "GET",
      path: "/viewer",
      operationId: "viewer",
      summary: "Read the signed-in account",
      description: "Returns the GitHub account of the person signed in with the session cookie.",
    })
    .output(Viewer),
  library: procedure
    .route({
      method: "GET",
      path: "/library",
      operationId: "library",
      summary: "List the signed-in account's stars",
      description: "Returns every repo the signed-in account starred, newest star first.",
    })
    .output(Library),
};
