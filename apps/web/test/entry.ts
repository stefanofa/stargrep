import { env } from "cloudflare:workers";
import { IconHost } from "@stargrep/api/icon-host";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { OwnerLookup, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import { accountRow, makeDb, memoryRateLines, repo as repoRow } from "@stargrep/db/testing";
import { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { layerCaller } from "../src/server/caller.ts";
import { withHealth } from "../src/server/health.ts";
import { layerRateLimiter } from "../src/server/rate-limiter.ts";
import { testServer } from "./serve.ts";

export const repo = repoRow(RepoId.make(42), {
  owner: Login.make("ratatui"),
  name: RepoName.make("ratatui"),
  nodeId: null,
  description: "Rust library for terminal user interfaces",
  topics: ["tui"],
  language: "Rust",
  license: "MIT",
  kind: "library",
  pushedAt: DateTime.makeUnsafe("2026-10-01T08:00:00Z"),
  summary: "A Rust library for terminal dashboards.",
  keywords: ["tui"],
  icon: { key: "v1/git/abc.webp", source: "repo-file", plate: "none", size: 128 },
  ownerType: "org",
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
});

const ada = accountRow(GitHubAccountId.make(7), { login: Login.make("ada"), starredCount: 1 });

const starredAt = DateTime.makeUnsafe("2026-03-01T00:00:00Z");

// Every sync request that reached admission, with who asked for it.
export const requested: Array<{ readonly login: Login; readonly by: SyncRequests.Requester }> = [];

export const waitingStart = DateTime.makeUnsafe("2026-11-06T09:01:30.500Z");

const looked = { starredTotal: null, accountType: null };

// Answers as admission would for the logins these tests use, because they test the router and the adapters around it.
// Admission itself runs against real SQL in core.
const admission = Layer.mock(SyncRequests.SyncRequests, {
  request: Effect.fn("SyncRequests.request")(function* (login: Login, by: SyncRequests.Requester) {
    requested.push({ login, by });
    const requestedAt = yield* DateTime.now;
    switch (login.toLowerCase()) {
      case "ghost-login":
        return yield* new SyncRequests.LoginNotFound({ login });
      case "budget-spent":
        return yield* new SyncRequests.SyncBusy({ reason: "github-budget" });
      case "line-full":
        return yield* new SyncRequests.SyncBusy({ reason: "line-full" });
      case "github-down":
        return yield* new OwnerLookup.OwnerLookupFailed({ reason: "github" });
      case "an-org":
        return { state: "done", syncedAt: requestedAt, starredTotal: 0, accountType: "org" } as const;
      case "patient":
        return {
          state: "waiting",
          requestedAt,
          startsAt: waitingStart,
          ahead: 2,
          syncedAt: null,
          starredTotal: 42,
          accountType: "user",
        } as const;
      default:
        return { state: "queued", requestedAt, syncedAt: null, ...looked } as const;
    }
  }),
  status: (login) =>
    Effect.succeed(
      login === ada.login
        ? { state: "done", syncedAt: starredAt, starredTotal: 1, accountType: "user" }
        : { state: "unknown", ...looked },
    ),
});

const search = Search.Search.of({
  search: Effect.fn("Search.search")(function* (request: Search.SearchRequest) {
    if (request.query === "database down") {
      return yield* new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null });
    }
    if (request.scope._tag !== "stars") return yield* new Search.SearchScopeUnavailable({ scope: request.scope._tag });
    if (request.scope.login !== ada.login) return yield* new Search.AccountNotSynced({ login: request.scope.login });
    return {
      plan: QueryPlan.asTyped(request.query, "sentence"),
      planSource: "fallback",
      results: [
        {
          repo,
          nameMatch: false,
          similarName: false,
          textRank: 1,
          vectorRank: 2,
          metrics: [{ metric: "stars", value: 18_000 }],
        },
      ],
      applied: [],
    } satisfies Search.SearchOutcome;
  }),
});

const db = makeDb({
  rateLines: memoryRateLines(),
  accounts: {
    byLogin: (login: Login) => Effect.succeed(login === ada.login ? Option.some(ada) : Option.none()),
  },
  repos: {
    require: (id: RepoId) => (id === repo.id ? Effect.succeed(repo) : Effect.fail(new RepoNotFound({ repoId: id }))),
  },
  stars: {
    page: () => Effect.succeed({ entries: [{ repo, starredAt, stars: 18_000, read: true }], next: Option.none() }),
    enrichment: (login: Login) =>
      Effect.succeed(login === ada.login ? { total: 1, read: 1, failed: 0 } : { total: 0, read: 0, failed: 0 }),
  },
  facets: {
    lookup: ({ limit }) =>
      Effect.succeed(
        [
          { atom: "subject:812", label: "PostgreSQL", repos: 1840 },
          { atom: "license:PostgreSQL", label: "PostgreSQL", repos: 31 },
        ].slice(0, limit),
      ),
  },
});

export const layerFor = (request: Request) =>
  Layer.mergeAll(
    Layer.succeed(Search.Search, search),
    Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()), signedIn: Effect.succeedNone })),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
    admission,
    layerRateLimiter(env),
    Layer.succeed(Db.Db, db),
  ).pipe(Layer.provideMerge(layerCaller(env.CALLER_KEY, request)));

const serve = testServer(layerFor);

export default {
  fetch: withHealth(env, (request) => serve(request) ?? Promise.resolve(new Response("Not found", { status: 404 }))),
} satisfies ExportedHandler<Cloudflare.Env>;
