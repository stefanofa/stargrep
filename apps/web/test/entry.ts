import { env } from "cloudflare:workers";
import { IconHost } from "@stargrep/api/icon-host";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { layerSyncLimiter, layerSyncQueue } from "../src/server/adapters.ts";
import { callerAddress, layerCaller } from "../src/server/caller.ts";
import { withHealth } from "../src/server/health.ts";
import { layerOwnerLookup } from "../src/server/owner-lookup.ts";
import { layerSearchLimiter } from "../src/server/search-limits.ts";
import { testServer } from "./serve.ts";

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

const ada = { id: 7 as GitHubAccountId, login: "ada" as Login, type: "user", starredCount: 1, starsSyncedAt: null };

const starredAt = DateTime.makeUnsafe("2026-03-01T00:00:00Z");

// Every message the sync queue was sent, as the real adapter sends it.
export const queued: Array<{ readonly body: { readonly login: string }; readonly delaySeconds: number | undefined }> =
  [];

const syncQueue = {
  send: async (body: { readonly login: string }, options?: QueueSendOptions) => {
    queued.push({ body, delaySeconds: options?.delaySeconds });
  },
} as unknown as Queue<unknown>;

// How long the next reservation waits in line, and whether the line refuses signed-out syncs.
export const line = { wait: Duration.zero, full: false };

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

const held = (login: Login, requestedAt: DateTime.Utc) =>
  Option.filter(Option.fromUndefinedOr(requests.get(login.toLowerCase())), (current) =>
    DateTime.Equivalence(current.requestedAt, requestedAt),
  );

export const syncRequests: Db.Db["Service"]["syncRequests"] = {
  get: (login) => Effect.sync(() => Option.fromUndefinedOr(requests.get(login.toLowerCase()))),
  claim: ({ login, at, cooldown }) =>
    Effect.sync(() => {
      const current = requests.get(login.toLowerCase());
      const claimed =
        current === undefined ||
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(current.startsAt ?? current.requestedAt, cooldown), at);
      if (claimed) {
        const key = login.toLowerCase();
        requests.set(key, { login: key, requestedAt: at, outcome: "pending", startsAt: null });
      }
      return claimed;
    }),
  ahead: (startsAt, at) =>
    Effect.sync(
      () =>
        [...requests.values()].filter(
          (request) =>
            request.outcome === "pending" &&
            request.startsAt !== null &&
            DateTime.isGreaterThan(request.startsAt, at) &&
            DateTime.isLessThan(request.startsAt, startsAt),
        ).length,
    ),
  schedule: (login, requestedAt, startsAt) =>
    Effect.sync(() =>
      Option.map(held(login, requestedAt), (current) => requests.set(current.login, { ...current, startsAt })),
    ),
  settle: (login, requestedAt, outcome) =>
    Effect.sync(() =>
      Option.map(held(login, requestedAt), (current) =>
        outcome === "released" ? requests.delete(current.login) : requests.set(current.login, { ...current, outcome }),
      ),
    ),
};

const db = {
  accounts: {
    byLogin: (login: Login) => Effect.succeed(login === ada.login ? Option.some(ada) : Option.none()),
    upsert: () => Effect.void,
    recordStarSync: () => Effect.void,
  },
  syncLine: {
    wait: () => Effect.sync(() => (line.full ? Duration.hours(3) : line.wait)),
    reserve: ({ line: key, at, force }: Db.Reservation) =>
      Effect.sync(() =>
        key !== "all"
          ? Option.some(at)
          : line.full && !force
            ? Option.none()
            : Option.some(DateTime.addDuration(at, line.wait)),
      ),
  },
  repos: {
    require: (id: RepoId) => (id === repo.id ? Effect.succeed(repo) : Effect.fail(new RepoNotFound({ repoId: id }))),
  },
  stars: {
    page: () => Effect.succeed({ entries: [{ repo, starredAt, stars: 18_000, read: true }], next: Option.none() }),
    enrichment: (login: Login) =>
      Effect.succeed(login === ada.login ? { total: 1, read: 1, failed: 0 } : { total: 0, read: 0, failed: 0 }),
  },
  syncRequests,
} as unknown as Db.Db["Service"];

const serve = testServer((request) =>
  Layer.mergeAll(
    Layer.succeed(Search.Search, search),
    Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()) })),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
    SyncRequests.layer,
    layerSyncLimiter(
      { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
      request.headers.get("cf-connecting-ip") ?? "unknown",
    ),
    layerSearchLimiter(env.SEARCH_PER_CALLER, callerAddress(request)),
    layerCaller(env.CALLER_KEY, request),
  ).pipe(
    Layer.provideMerge(Layer.succeed(Db.Db, db)),
    Layer.provide(Layer.merge(layerSyncQueue(syncQueue), layerOwnerLookup(env.WORKER))),
  ),
);

export default {
  fetch: withHealth(env, (request) => serve(request) ?? Promise.resolve(new Response("Not found", { status: 404 }))),
} satisfies ExportedHandler<Cloudflare.Env>;
