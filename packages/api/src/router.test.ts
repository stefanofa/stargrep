import { describe, expect, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { IconHost } from "./icon-host.ts";
import type { Transport } from "./middleware/instrumentation.ts";
import { type ApiContext, type ApiServices, ApiServicesUnavailable, router } from "./router.ts";
import { SyncLimiter, SyncLimiterUnavailable, SyncRateLimited } from "./sync-limiter.ts";
import { NotSignedIn, type Viewer, type ViewerError, Viewers, ViewerUnavailable } from "./viewers.ts";

const canary = "PRIVATE_QUERY_CANARY";
const pushedAt = DateTime.makeUnsafe("2026-10-01T08:00:00Z");

const repo: Db.Repo = {
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
  pushedAt,
  archived: false,
  readmeOid: null,
  summary: `A Rust library for dashboards. ${canary}`,
  summaryReadmeOid: null,
  keywords: ["tui"],
  embeddingModel: null,
  icon: { key: "v1/git/abc.webp", source: "repo-file", plate: "dark", size: 96 },
  iconCheckedAt: pushedAt,
  ownerType: "org",
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
};

const unchecked: Db.Repo = {
  ...repo,
  id: 44 as RepoId,
  icon: null,
  iconCheckedAt: null,
  ownerType: null,
  ownerAvatarUrl: null,
};

interface Fakes {
  readonly search?: (request: Search.SearchRequest) => Effect.Effect<Search.SearchOutcome, Search.SearchError>;
  readonly limiter?: Effect.Effect<void, SyncRateLimited | SyncLimiterUnavailable>;
  readonly requests?: SyncRequests.SyncRequests["Service"];
  readonly sent?: Array<Login>;
  readonly viewer?: Effect.Effect<Viewer, ViewerError>;
}

const ada: Viewer = {
  userId: UserId.make("user-ada"),
  account: {
    id: 7 as GitHubAccountId,
    type: "user",
    login: "ada" as Login,
    name: "Ada",
    avatarUrl: "https://avatars.githubusercontent.com/u/7",
    followers: null,
    publicRepos: null,
    ownedRepoStars: null,
    claimedBy: UserId.make("user-ada"),
    starredCount: 2431,
    starsEtag: null,
    starsSyncedAt: null,
    starsFullSyncedAt: null,
  },
};

const starredAt = DateTime.makeUnsafe("2025-03-14T10:00:00Z");

const searchOutcome = (request: Search.SearchRequest): Search.SearchOutcome => ({
  plan: QueryPlan.asTyped(request.query, "sentence"),
  planSource: "fallback",
  results: [{ repo, nameMatch: false, textRank: 2, vectorRank: 1, metrics: [{ metric: "stars", value: 18_000 }] }],
});

const searchAda = (request: Search.SearchRequest) =>
  request.scope._tag !== "stars"
    ? Effect.fail(new Search.SearchScopeUnavailable({ scope: request.scope._tag }))
    : request.scope.login === "ada"
      ? Effect.succeed(searchOutcome(request))
      : Effect.fail(new Search.AccountNotSynced({ login: request.scope.login }));

const reading = { total: 1776, read: 412, failed: 3 };

const services = (fakes: Fakes): Context.Context<ApiServices> => {
  const db = {
    repos: {
      require: (id: RepoId) =>
        id === repo.id
          ? Effect.succeed(repo)
          : id === unchecked.id
            ? Effect.succeed(unchecked)
            : Effect.fail(new RepoNotFound({ repoId: id })),
    },
    stars: {
      enrichment: () => Effect.succeed(reading),
      library: (accountId: GitHubAccountId) =>
        Effect.succeed(accountId === ada.account.id ? [{ repo, starredAt, stars: 16_400, read: false }] : []),
    },
  } as unknown as Db.Db["Service"];
  const requests =
    fakes.requests ??
    SyncRequests.SyncRequests.of({
      request: (login) =>
        Effect.sync(() => {
          fakes.sent?.push(login);
          return { state: "queued", requestedAt: pushedAt, syncedAt: null };
        }),
      status: () => Effect.succeed({ state: "failed", requestedAt: pushedAt, syncedAt: null }),
    });
  return Context.make(Db.Db, db).pipe(
    Context.add(
      Search.Search,
      Search.Search.of({
        search: (request) => (fakes.search ?? searchAda)(request).pipe(Effect.withSpan("Search.search")),
      }),
    ),
    Context.add(SyncRequests.SyncRequests, requests),
    Context.add(SyncLimiter, SyncLimiter.of({ acquire: fakes.limiter ?? Effect.void })),
    Context.add(Viewers, Viewers.of({ current: fakes.viewer ?? Effect.fail(new NotSignedIn()) })),
    Context.add(IconHost, IconHost.of({ origin: "https://stargrep.test" })),
  );
};

const contextFor = (
  transport: Transport,
  servicesEffect: ApiContext["services"],
  tracer: Tracer.Tracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
): ApiContext => ({
  "effect/context": Context.make(Tracer.Tracer, tracer),
  transport,
  procedureTime: Ref.makeUnsafe(Option.none()),
  services: servicesEffect,
});

const client = (fakes: Fakes = {}, transport: Transport = "rpc") => {
  const collected = collectSpans();
  const context = contextFor(transport, Effect.succeed(services(fakes)), collected.tracer);
  return { collected, context, api: createRouterClient(router, { context }) };
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => {
      if (!(error instanceof ORPCError)) throw error;
      return error;
    },
  );

const traceData = { traceId: expect.stringMatching(/^[0-9a-f]{32}$/) };

describe("search", () => {
  test("returns ranked repos with reason lines and ISO times, and records the call's time", async () => {
    const { api, context } = client();
    expect(await api.search({ login: "ada", q: "terminal dashboards" })).toEqual({
      planSource: "fallback",
      results: [
        {
          id: 42 as RepoId,
          owner: "ratatui",
          name: "ratatui",
          url: "https://github.com/ratatui/ratatui",
          description: "Rust library for terminal user interfaces",
          summary: repo.summary,
          language: "Rust",
          topics: ["tui"],
          license: "MIT",
          kind: "library",
          archived: false,
          pushedAt: "2026-10-01T08:00:00.000Z",
          icon: { url: "https://stargrep.test/icons/v1/git/abc.webp", plate: "dark", size: 96 },
          ownerType: "org",
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
          reason: "keyword match #2, meaning match #1, 18K stars",
          rankedBy: ["18K stars"],
          metrics: [{ metric: "stars", value: 18_000 }],
        },
      ],
    });
    const recorded = Ref.getUnsafe(context.procedureTime);
    expect(Option.map(recorded, Duration.isDuration)).toEqual(Option.some(true));
  });

  test("searches the login's own stars with the default limit", async () => {
    const requests: Array<Search.SearchRequest> = [];
    const { api } = client({
      search: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return searchOutcome(request);
        }),
    });
    await api.search({ login: "ada", q: "terminal dashboards" });
    expect(requests).toEqual([
      { scope: { _tag: "stars", login: "ada" as Login }, query: "terminal dashboards", limit: 20 },
    ]);
  });

  test("rejects an empty query and a login GitHub would not issue, with the issues and a trace ID", async () => {
    const { api } = client();
    for (const [input, field] of [
      [{ login: "ada", q: "   " }, "q"],
      [{ login: "ada/../../repos", q: "dashboards" }, "login"],
      [{ login: "ada", q: "dashboards", limit: 500 }, "limit"],
    ] as const) {
      const error = await failure(api.search(input));
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.data).toEqual({ issues: [expect.objectContaining({ path: [field] })], ...traceData });
    }
  });

  test("maps every search failure through the error table with a trace ID and no detail", async () => {
    const { api } = client();
    expect((await failure(api.search({ login: "grace", q: "dashboards" }))).toJSON()).toEqual({
      defined: true,
      code: "ACCOUNT_NOT_SYNCED",
      message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
      data: traceData,
    });
    expect((await failure(api.search({ login: "ada", q: "x", scope: "network" }))).code).toBe("SCOPE_UNAVAILABLE");
    expect((await failure(api.search({ login: "ada", q: "x", scope: "global" }))).code).toBe("SCOPE_UNAVAILABLE");

    const broken = client({
      search: () => Effect.fail(new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null })),
    });
    const error = await failure(broken.api.search({ login: "ada", q: "x" }));
    expect(error.toJSON()).toMatchObject({ defined: true, code: "SERVICE_UNAVAILABLE", data: traceData });
    expect(JSON.stringify(error.toJSON())).not.toContain("search.hybrid");
  });

  test("turns a defect into an internal error with the call's trace ID", async () => {
    const { api, collected } = client({ search: () => Effect.die(new Error(`boom ${canary}`)) });
    const error = await failure(api.search({ login: "ada", q: "x" }));
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(error.toJSON())).not.toContain(canary);
    expect(error.data).toEqual({ traceId: collected.named("Api.search")?.traceId });
  });

  test("opens one span per call, with no query text or result in any span", async () => {
    const { api, collected } = client({}, "mcp");
    await api.search({ login: "ada", q: `dashboards ${canary}` });
    expect(collected.spans.map((each) => each.name)).toEqual(["Api.search", "Search.search"]);
    const span = collected.named("Api.search");
    expect(span?.attributes.get("api.transport")).toBe("mcp");
    expect(span?.attributes.get("stargrep.trace_id")).toBe(span?.traceId);
    const parent = Option.flatMap(Option.fromUndefinedOr(collected.named("Search.search")), (child) => child.parent);
    expect(Option.map(parent, (found) => found.spanId)).toEqual(Option.fromUndefinedOr(span?.spanId));
    expect(collected.text()).not.toContain(canary);
  });
});

describe("sync", () => {
  test("queues a sync and reports a failed one", async () => {
    const sent: Array<Login> = [];
    const { api } = client({ sent });
    expect(await api.triggerSync({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "queued",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
      enrichment: reading,
    });
    expect(sent).toEqual(["octocat" as Login]);
    expect(await api.syncStatus({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "failed",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
      enrichment: reading,
    });
  });

  test("refuses a caller over the rate limit without queueing, and treats a limiter outage as unavailable", async () => {
    const sent: Array<Login> = [];
    const limited = client({ sent, limiter: Effect.fail(new SyncRateLimited({ limit: "caller" })) });
    expect((await failure(limited.api.triggerSync({ login: "octocat" }))).code).toBe("TOO_MANY_REQUESTS");
    const down = client({ sent, limiter: Effect.fail(new SyncLimiterUnavailable({ cause: "down" })) });
    expect((await failure(down.api.triggerSync({ login: "octocat" }))).code).toBe("SERVICE_UNAVAILABLE");
    expect(sent).toEqual([]);
  });

  test("maps a sync queue failure to service unavailable", async () => {
    const { api } = client({
      requests: SyncRequests.SyncRequests.of({
        request: () => Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "down" })),
        status: () => Effect.succeed({ state: "unknown" }),
      }),
    });
    expect((await failure(api.triggerSync({ login: "octocat" }))).code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("getRepo", () => {
  test("returns a stored repo and says when there is none", async () => {
    const { api } = client();
    expect(await api.getRepo({ id: 42 as RepoId })).toMatchObject({
      id: 42,
      url: "https://github.com/ratatui/ratatui",
      keywords: ["tui"],
      pushedAt: "2026-10-01T08:00:00.000Z",
    });
    expect((await failure(api.getRepo({ id: 43 as RepoId }))).code).toBe("REPO_NOT_FOUND");
  });

  test("serves the icon on the icon host, and null icon and owner facts before the icon check", async () => {
    const { api } = client();
    expect(await api.getRepo({ id: 42 as RepoId })).toMatchObject({
      icon: { url: "https://stargrep.test/icons/v1/git/abc.webp", plate: "dark", size: 96 },
      ownerType: "org",
      ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    expect(await api.getRepo({ id: 44 as RepoId })).toMatchObject({
      icon: null,
      ownerType: null,
      ownerAvatarUrl: null,
    });
  });
});

describe("signed-in procedures", () => {
  test("refuse a caller with no session", async () => {
    const { api } = client();
    for (const call of [api.viewer(), api.library()]) {
      const error = await failure(call);
      expect([error.code, error.data]).toEqual(["UNAUTHORIZED", traceData]);
    }
  });

  test("return the signed-in account and its stars, newest first", async () => {
    const { api } = client({ viewer: Effect.succeed(ada) });
    expect(await api.viewer()).toEqual({
      login: "ada",
      name: "Ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      starredCount: 2431,
    });
    expect(await api.library()).toEqual({
      repos: [
        expect.objectContaining({
          id: 42,
          owner: "ratatui",
          name: "ratatui",
          keywords: ["tui"],
          starredAt: "2025-03-14T10:00:00.000Z",
          stars: 16_400,
          read: false,
          icon: { url: "https://stargrep.test/icons/v1/git/abc.webp", plate: "dark", size: 96 },
          ownerType: "org",
        }),
      ],
    });
  });

  test("map an unreadable session to service unavailable", async () => {
    const { api } = client({ viewer: Effect.fail(new ViewerUnavailable({ step: "session" })) });
    expect((await failure(api.library())).code).toBe("SERVICE_UNAVAILABLE");
  });
});

const now = Date.parse("2026-11-05T12:55:30Z");
const queue = SyncQueue.layerMemory();

const syncedAccount = Effect.gen(function* () {
  const db = yield* Db.Db;
  const { id, type, login, name, avatarUrl, followers, publicRepos } = ada.account;
  const lastSync = DateTime.makeUnsafe(now - 80 * 60_000);
  yield* db.accounts.upsert({ id, type, login, name, avatarUrl, followers, publicRepos });
  yield* db.stars.applySnapshot({ accountId: id, stars: [], at: lastSync });
  yield* db.accounts.recordStarSync({ accountId: id, etag: null, at: lastSync });
});

const signedInWith = (sender: Layer.Layer<SyncQueue.SyncQueue>) =>
  SyncRequests.layer.pipe(
    Layer.provideMerge(TestDatabase.layerMemory({ embeddingModel: "test/model" as EmbeddingModelId })),
    Layer.provideMerge(sender),
  );

const ownerApi = Effect.gen(function* () {
  const real = yield* Effect.context<Db.Db | SyncRequests.SyncRequests>();
  const fakes = services({ viewer: Effect.succeed(ada) });
  const merged = Context.merge(fakes, real);
  return createRouterClient(router, { context: contextFor("rpc", Effect.succeed(merged)) });
});

const openLibrary = Effect.gen(function* () {
  const api = yield* ownerApi;
  yield* Effect.promise(() => api.viewer());
  return yield* Effect.promise(() => api.syncStatus({ login: ada.account.login }));
});

const resetOwner = Effect.gen(function* () {
  queue.sent.length = 0;
  yield* (yield* TestDatabase.TestDatabase).query("truncate github_accounts, sync_requests cascade");
  yield* TestClock.setTime(now);
  yield* syncedAccount;
});

it.layer(signedInWith(queue.layer), { timeout: 30_000 })("opening the library", (it) => {
  it.effect("starts a sync that syncStatus reports as queued right after", () =>
    Effect.gen(function* () {
      yield* resetOwner;
      expect(yield* openLibrary).toMatchObject({
        login: "ada",
        state: "queued",
        requestedAt: "2026-11-05T12:55:30.000Z",
        syncedAt: "2026-11-05T11:35:30.000Z",
      });
      expect(queue.sent).toEqual([
        { login: ada.account.login, mode: "incremental", requestedAt: DateTime.makeUnsafe(now) },
      ]);
    }),
  );

  it.effect("starts at most one sync a minute however often the owner opens it", () =>
    Effect.gen(function* () {
      yield* resetOwner;
      yield* openLibrary;
      yield* TestClock.adjust("59 seconds");
      expect(yield* openLibrary).toMatchObject({ state: "queued", requestedAt: "2026-11-05T12:55:30.000Z" });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect(yield* openLibrary).toMatchObject({ state: "queued", requestedAt: "2026-11-05T12:56:30.000Z" });
      expect(queue.sent).toHaveLength(2);
    }),
  );
});

const downQueue = Layer.succeed(
  SyncQueue.SyncQueue,
  SyncQueue.SyncQueue.of({ send: () => Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "down" })) }),
);

it.layer(signedInWith(downQueue), { timeout: 30_000 })("opening the library with the sync queue down", (it) => {
  it.effect("still answers the viewer and reports the sync failed", () =>
    Effect.gen(function* () {
      yield* resetOwner;
      const api = yield* ownerApi;
      expect(yield* Effect.promise(() => api.viewer())).toMatchObject({ login: "ada" });
      expect(yield* Effect.promise(() => api.syncStatus({ login: ada.account.login }))).toMatchObject({
        state: "failed",
        requestedAt: "2026-11-05T12:55:30.000Z",
      });
    }),
  );
});

test("validates input without starting the services, and maps a failed start to service unavailable", async () => {
  let starts = 0;
  const api = createRouterClient(router, {
    context: contextFor(
      "rest",
      Effect.suspend(() => {
        starts++;
        return Effect.fail(new ApiServicesUnavailable({ failure: "DbQueryFailed" }));
      }),
    ),
  });
  expect((await failure(api.search({ login: "ada", q: " " }))).code).toBe("BAD_REQUEST");
  expect(starts).toBe(0);
  const error = await failure(api.search({ login: "ada", q: "dashboards" }));
  expect(error.toJSON()).toMatchObject({ code: "SERVICE_UNAVAILABLE", data: traceData });
  expect(starts).toBe(1);
});
