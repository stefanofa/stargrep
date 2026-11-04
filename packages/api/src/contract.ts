import "@orpc/effect/extensions/schema";
import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { mcp } from "@orpc/mcp";
import { MetricRegistry, QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
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
});

export const SearchResult = Schema.Struct({
  ...RepoFields.fields,
  reason: Schema.String.annotate({
    description: "Why the repo matched, such as 'keyword match #2, +38% contributors in 90 days'.",
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

export const SyncStatus = Schema.Struct({
  login: Schema.String,
  state: SyncRequests.SyncState.annotate({
    description:
      "unknown means Stargrep never synced the login, queued means a sync is waiting or running, failed means the last requested sync could not finish, and done means the stars are synced.",
  }),
  requestedAt: Schema.NullOr(Timestamp),
  syncedAt: Schema.NullOr(Timestamp),
});

export const RepoInput = Schema.Struct({ id: RepoId.annotate({ description: "The GitHub repo ID." }) });

export const RepoDetail = Schema.Struct({
  ...RepoFields.fields,
  keywords: Schema.Array(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Timestamp),
});

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
        "Says whether a login's stars are synced, queued for a sync, failed to sync, or unknown to Stargrep.",
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
};
