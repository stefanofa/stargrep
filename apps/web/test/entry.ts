import { env } from "cloudflare:workers";
import { IconHost } from "@stargrep/api/icon-host";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { layerSyncLimiter } from "../src/server/adapters.ts";
import { withHealth } from "../src/server/health.ts";
import { makeServer } from "../src/server/serve.ts";

export const repo: Db.Repo = {
  id: 42 as RepoId,
  owner: "ratatui" as Login,
  name: "ratatui" as RepoName,
  nodeId: null,
  description: "Rust library for terminal user interfaces",
  topics: ["tui"],
  language: "Rust",
  license: "MIT",
  homepage: null,
  kind: "library",
  createdAt: null,
  pushedAt: DateTime.makeUnsafe("2026-10-01T08:00:00Z"),
  archived: false,
  readmeOid: null,
  summary: "A Rust library for terminal dashboards.",
  summaryReadmeOid: null,
  keywords: ["tui"],
  embeddingModel: null,
  icon: { key: "v1/git/abc.webp", source: "repo-file", plate: "none", size: 128 },
  iconCheckedAt: null,
  ownerType: "org",
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
};

const ada = { id: 7 as GitHubAccountId, login: "ada" as Login, starsSyncedAt: null };

export const queue = SyncQueue.layerMemory();

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
      results: [{ repo, nameMatch: false, textRank: 1, vectorRank: 2, metrics: [{ metric: "stars", value: 18_000 }] }],
    } satisfies Search.SearchOutcome;
  }),
});

const requests = new Map<string, Db.SyncRequest>();

export const syncRequests: Db.Db["Service"]["syncRequests"] = {
  get: (login) => Effect.sync(() => Option.fromUndefinedOr(requests.get(login.toLowerCase()))),
  claim: ({ login, at, cooldown }) =>
    Effect.sync(() => {
      const current = requests.get(login.toLowerCase());
      const claimed =
        current === undefined || DateTime.isLessThanOrEqualTo(DateTime.addDuration(current.requestedAt, cooldown), at);
      if (claimed)
        requests.set(login.toLowerCase(), { login: login.toLowerCase(), requestedAt: at, outcome: "pending" });
      return claimed;
    }),
  markFailed: (login, requestedAt) =>
    Effect.sync(() => {
      const current = requests.get(login.toLowerCase());
      if (current !== undefined && DateTime.Equivalence(current.requestedAt, requestedAt)) {
        requests.set(login.toLowerCase(), { ...current, outcome: "failed" });
      }
    }),
};

const db = {
  accounts: { byLogin: (login: Login) => Effect.succeed(login === ada.login ? Option.some(ada) : Option.none()) },
  repos: {
    require: (id: RepoId) => (id === repo.id ? Effect.succeed(repo) : Effect.fail(new RepoNotFound({ repoId: id }))),
  },
  stars: {
    enrichment: (login: Login) =>
      Effect.succeed(login === ada.login ? { total: 1, read: 1, failed: 0 } : { total: 0, read: 0, failed: 0 }),
  },
  syncRequests,
} as unknown as Db.Db["Service"];

const serve = makeServer(
  (request) =>
    Layer.mergeAll(
      Layer.succeed(Search.Search, search),
      Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()) })),
      Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
      SyncRequests.layer,
      layerSyncLimiter(
        { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
        request.headers.get("cf-connecting-ip") ?? "unknown",
      ),
    ).pipe(Layer.provideMerge(Layer.succeed(Db.Db, db)), Layer.provide(queue.layer)),
  Layer.empty,
);

export default {
  fetch: withHealth(env, (request) => serve(request) ?? Promise.resolve(new Response("Not found", { status: 404 }))),
} satisfies ExportedHandler<Cloudflare.Env>;
