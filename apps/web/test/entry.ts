import { env } from "cloudflare:workers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { layerSyncLimiter, layerSyncRequestLog } from "../src/server/adapters.ts";
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
};

const ada = { id: 7 as GitHubAccountId, login: "ada" as Login, starsSyncedAt: null };

export const queue = SyncQueue.layerMemory();

const search = Search.Search.of({
  search: Effect.fn("Search.search")(function* (request: Search.SearchRequest) {
    if (request.query === "database down") {
      return yield* new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null });
    }
    if (request.scope._tag !== "stars") return yield* new Search.SearchScopeUnavailable({ scope: request.scope._tag });
    return {
      plan: QueryPlan.asTyped(request.query, "sentence"),
      planSource: "fallback",
      results: [{ repo, nameMatch: false, textRank: 1, vectorRank: 2, metrics: [{ metric: "stars", value: 18_000 }] }],
    } satisfies Search.SearchOutcome;
  }),
});

const db = {
  accounts: { byLogin: (login: Login) => Effect.succeed(login === ada.login ? Option.some(ada) : Option.none()) },
  repos: { get: (id: RepoId) => Effect.succeed(id === repo.id ? Option.some(repo) : Option.none()) },
} as unknown as Db.Db["Service"];

const serve = makeServer(
  (request) =>
    Layer.mergeAll(
      Layer.succeed(Search.Search, search),
      SyncRequests.layer,
      layerSyncLimiter(
        { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
        request.headers.get("cf-connecting-ip") ?? "unknown",
      ),
    ).pipe(
      Layer.provideMerge(Layer.succeed(Db.Db, db)),
      Layer.provide(Layer.merge(queue.layer, layerSyncRequestLog(env.SYNC_REQUESTS))),
    ),
  Layer.empty,
);

export default {
  fetch: (request) => serve(request) ?? Promise.resolve(new Response("Not found", { status: 404 })),
} satisfies ExportedHandler<Cloudflare.Env>;
