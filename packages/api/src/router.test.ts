import { describe, expect, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import { AiSpendLimited } from "@stargrep/ai/errors";
import { QueryPlan, Search } from "@stargrep/core/search";
import { OwnerLookup, SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
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
import * as AnswerCache from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import { errorStatus, type WireCode } from "./errors.ts";
import { IconHost } from "./icon-host.ts";
import type { Transport } from "./middleware/instrumentation.ts";
import { type ApiContext, type ApiServices, ApiServicesUnavailable, router } from "./router.ts";
import { SearchLimiter, SearchLimiterUnavailable, SearchRateLimited } from "./search-limiter.ts";
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
  readonly searchLimiter?: Effect.Effect<void, SearchRateLimited | SearchLimiterUnavailable>;
  readonly requests?: SyncRequests.SyncRequests["Service"];
  readonly sent?: Array<readonly [Login, SyncRequests.Requester]>;
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
      request: (login, by) =>
        Effect.sync(() => {
          fakes.sent?.push([login, by]);
          return { state: "queued", requestedAt: pushedAt, syncedAt: null, starredTotal: null, accountType: null };
        }),
      status: () =>
        Effect.succeed({
          state: "failed",
          requestedAt: pushedAt,
          syncedAt: null,
          starredTotal: null,
          accountType: null,
        }),
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
    Context.add(SearchLimiter, SearchLimiter.of({ acquire: fakes.searchLimiter ?? Effect.void })),
    Context.add(Viewers, Viewers.of({ current: fakes.viewer ?? Effect.fail(new NotSignedIn()) })),
    Context.add(IconHost, IconHost.of({ origin: "https://stargrep.test" })),
    Context.add(Caller, Caller.of({ key: Db.CallerKey.make("caller-test") })),
  );
};

const publicConfig = {
  demoLogin: "ada",
  demoQuery: "terminal dashboards",
  examples: ["postgres for ai agents"],
  featured: ["ada"],
};

const contextFor = (
  transport: Transport,
  servicesEffect: ApiContext["services"],
  tracer: Tracer.Tracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
): ApiContext => ({
  "effect/context": Context.make(Tracer.Tracer, tracer),
  transport,
  publicConfig,
  procedureTime: Ref.makeUnsafe(Option.none()),
  services: servicesEffect,
  answerCache: AnswerCache.disabled,
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
    const sent: Array<readonly [Login, SyncRequests.Requester]> = [];
    const { api } = client({ sent });
    expect(await api.triggerSync({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "queued",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
      waiting: null,
      starredTotal: null,
      accountType: null,
      enrichment: reading,
    });
    expect(sent).toEqual([["octocat" as Login, { _tag: "anyone", caller: Db.CallerKey.make("caller-test") }]]);
    expect(await api.syncStatus({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "failed",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
      waiting: null,
      starredTotal: null,
      accountType: null,
      enrichment: reading,
    });
  });

  test("refuses a caller over the rate limit without queueing, and treats a limiter outage as unavailable", async () => {
    const sent: Array<readonly [Login, SyncRequests.Requester]> = [];
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
        status: () => Effect.succeed({ state: "unknown", starredTotal: null, accountType: null }),
      }),
    });
    expect((await failure(api.triggerSync({ login: "octocat" }))).code).toBe("SERVICE_UNAVAILABLE");
  });

  test("maps a missing login, a busy line, a caller over its new logins, and a failed lookup", async () => {
    const failingWith = (error: SyncRequests.SyncRequestError) =>
      client({
        requests: SyncRequests.SyncRequests.of({
          request: () => Effect.fail(error),
          status: () => Effect.succeed({ state: "unknown", starredTotal: null, accountType: null }),
        }),
      }).api.triggerSync({ login: "octocat" });
    const cases = [
      [new SyncRequests.LoginNotFound({ login: "octocat" }), "LOGIN_NOT_FOUND"],
      [new SyncRequests.SyncBusy({ reason: "line-full" }), "SYNC_BUSY"],
      [new SyncRequests.SyncBusy({ reason: "github-budget" }), "SYNC_BUSY"],
      [new SyncRequests.NewAccountLimited(), "TOO_MANY_REQUESTS"],
      [new OwnerLookup.OwnerLookupFailed({ reason: "timeout" }), "SERVICE_UNAVAILABLE"],
    ] as const;
    for (const [error, code] of cases) {
      const wire = await failure(failingWith(error));
      expect([wire.code, wire.data]).toEqual([code, traceData]);
    }
  });

  test("reports a sync waiting in line with its place and start, and the login's starred total and type", async () => {
    const startsAt = DateTime.makeUnsafe("2026-10-01T08:12:00Z");
    const { api } = client({
      requests: SyncRequests.SyncRequests.of({
        request: () => Effect.die("not called"),
        status: () =>
          Effect.succeed({
            state: "waiting",
            requestedAt: pushedAt,
            startsAt,
            ahead: 3,
            syncedAt: null,
            starredTotal: 2_431,
            accountType: "user",
          }),
      }),
    });
    expect(await api.syncStatus({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "waiting",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
      waiting: { ahead: 3, startsAt: "2026-10-01T08:12:00.000Z" },
      starredTotal: 2_431,
      accountType: "user",
      enrichment: reading,
    });
  });
});

describe("config", () => {
  test("returns the public settings without building the request's services", async () => {
    const context = contextFor("rest", Effect.die("the config needs no services"));
    expect(await createRouterClient(router, { context }).config()).toEqual(publicConfig);
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
    Layer.provideMerge(OwnerLookup.layerMemory().layer),
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
        { login: ada.account.login, mode: "incremental", requestedAt: DateTime.makeUnsafe(now), reserved: 2 },
      ]);
    }),
  );

  it.effect("waits for a queued sync, then starts at most one a minute after the last one finished", () =>
    Effect.gen(function* () {
      yield* resetOwner;
      yield* openLibrary;
      yield* TestClock.adjust("70 seconds");
      expect(yield* openLibrary).toMatchObject({ state: "queued", requestedAt: "2026-11-05T12:55:30.000Z" });
      const finished = DateTime.makeUnsafe(now + 40_000);
      yield* Db.Db.use((db) => db.accounts.recordStarSync({ accountId: ada.account.id, etag: null, at: finished }));
      expect(yield* openLibrary).toMatchObject({ state: "done", syncedAt: "2026-11-05T12:56:10.000Z" });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust("30 seconds");
      expect(yield* openLibrary).toMatchObject({ state: "queued", requestedAt: "2026-11-05T12:57:10.000Z" });
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

const demoSearch = (planSource: Search.SearchOutcome["planSource"] = "model") => {
  const searched: Array<Search.SearchRequest> = [];
  let builds = 0;
  const fakes: Fakes = {
    search: (request) =>
      Effect.sync(() => {
        searched.push(request);
        const outcome = searchOutcome(request);
        return {
          ...outcome,
          planSource,
          results: outcome.results.map((result) => ({
            ...result,
            metrics: [{ metric: "stars" as const, value: searched.length }],
          })),
        };
      }),
  };
  const built = Effect.sync(() => {
    builds++;
    return services(fakes);
  });
  const memory = AnswerCache.memory(built);
  const call = (
    input: { readonly login: string; readonly q: string; readonly scope?: "stars" | "network" },
    servicesEffect: ApiContext["services"] = built,
  ) =>
    Effect.gen(function* () {
      const resHeaders = new Headers();
      const context: ApiContext = {
        ...contextFor("rpc", servicesEffect),
        "effect/context": yield* Effect.context<never>(),
        answerCache: memory.cache,
        resHeaders,
      };
      const answer = yield* Effect.promise(() => createRouterClient(router, { context }).search(input));
      return { cache: resHeaders.get("x-answer-cache"), stars: answer.results[0]?.metrics[0]?.value, answer };
    });
  return { searched, builds: () => builds, memory, call };
};

const noServices = Effect.die("a cached answer needs no services");

describe("the demo answer cache", () => {
  it.effect("computes a demo search once, then serves it with no services, whatever the login's case and spacing", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      expect(yield* demo.call({ login: "ada", q: "terminal dashboards" })).toMatchObject({ cache: "miss", stars: 1 });
      expect(yield* demo.call({ login: "ADA", q: "  Terminal   dashboards " }, noServices)).toMatchObject({
        cache: "hit",
        stars: 1,
      });
      expect([demo.searched.length, demo.builds()]).toEqual([1, 1]);
      expect([...demo.memory.entries.keys()]).toEqual(["search/ada/stars/20/terminal dashboards"]);
    }),
  );

  it.effect("serves a stale answer past 5 minutes while a refresh stores a new one, and misses past a day", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      const query = { login: "ada", q: "terminal dashboards" };
      yield* demo.call(query);
      yield* TestClock.adjust("4 minutes");
      expect(yield* demo.call(query, noServices)).toMatchObject({ cache: "hit", stars: 1 });
      yield* TestClock.adjust("2 minutes");
      expect(yield* demo.call(query, noServices)).toMatchObject({ cache: "stale", stars: 1 });
      expect(demo.memory.refreshes).toHaveLength(1);
      expect(yield* demo.call(query, noServices)).toMatchObject({ cache: "hit", stars: 2 });
      yield* TestClock.adjust("1 day");
      expect(yield* demo.call(query, noServices)).toMatchObject({ cache: "stale", stars: 2 });
      yield* TestClock.adjust(Duration.sum(Duration.days(1), Duration.minutes(6)));
      expect(yield* demo.call(query)).toMatchObject({ cache: "miss", stars: 4 });
      expect(demo.builds()).toBe(4);
    }),
  );

  it.effect("never stores an answer the planner could not plan", () =>
    Effect.gen(function* () {
      const demo = demoSearch("fallback");
      const query = { login: "ada", q: "terminal dashboards" };
      expect((yield* demo.call(query)).cache).toBe("miss");
      expect((yield* demo.call(query)).cache).toBe("miss");
      expect([demo.searched.length, demo.memory.entries.size]).toEqual([2, 0]);
    }),
  );

  it.effect("never caches another login's search or another scope", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      for (const query of [
        { login: "grace", q: "terminal dashboards" },
        { login: "ada", q: "terminal dashboards", scope: "network" as const },
      ]) {
        expect((yield* demo.call(query)).cache).toBeNull();
        expect((yield* demo.call(query)).cache).toBeNull();
      }
      expect([demo.searched.length, demo.memory.entries.size]).toEqual([4, 0]);
    }),
  );

  it.effect("takes from the network's search limit only when a search runs, never for a cached demo answer", () =>
    Effect.gen(function* () {
      let acquired = 0;
      let refuse = false;
      const limiter = Effect.suspend(() => {
        acquired++;
        return refuse ? Effect.fail(new SearchRateLimited()) : Effect.void;
      });
      const demo = demoSearch();
      const planned = (request: Search.SearchRequest) =>
        Effect.succeed({ ...searchOutcome(request), planSource: "model" as const });
      const limited = Effect.succeed(services({ search: planned, searchLimiter: limiter }));
      yield* demo.call({ login: "ada", q: "terminal dashboards" }, limited);
      refuse = true;
      expect((yield* demo.call({ login: "ada", q: "terminal dashboards" }, limited)).cache).toBe("hit");
      expect(acquired).toBe(1);
      const error = yield* Effect.promise(() =>
        failure(client({ searchLimiter: limiter }).api.search({ login: "ada", q: "other words" })),
      );
      expect([error.code, acquired]).toEqual(["TOO_MANY_REQUESTS", 2]);
    }),
  );
});

describe("search limits", () => {
  test("map a limiter outage to service unavailable and a refused planner to too many requests", async () => {
    const down = client({ searchLimiter: Effect.fail(new SearchLimiterUnavailable({ cause: "down" })) });
    expect((await failure(down.api.search({ login: "grace", q: "x" }))).code).toBe("SERVICE_UNAVAILABLE");
    const spent = client({ search: () => Effect.fail(new AiSpendLimited({ operation: "embed", limit: "caller" })) });
    const error = await failure(spent.api.search({ login: "grace", q: "x" }));
    expect([error.code, errorStatus[error.code as WireCode]]).toEqual(["TOO_MANY_REQUESTS", 429]);
  });
});

describe("config headers", () => {
  test("lets browsers keep the public settings for 5 minutes", async () => {
    const resHeaders = new Headers();
    const context = { ...contextFor("rest", Effect.die("the config needs no services")), resHeaders };
    await createRouterClient(router, { context }).config();
    expect(resHeaders.get("cache-control")).toBe("public, max-age=300");
  });
});

const starAt = (repoId: number, iso: string) => ({
  repoId: repoId as RepoId,
  starredAt: DateTime.makeUnsafe(iso),
  observedAt: DateTime.makeUnsafe(iso),
  source: "api" as const,
});

const starsApi = Effect.gen(function* () {
  const real = yield* Effect.context<Db.Db>();
  const memory = AnswerCache.memory(Effect.succeed(Context.merge(services({}), real)));
  return (input: { readonly login: string; readonly limit?: number; readonly cursor?: string }) =>
    Effect.gen(function* () {
      const resHeaders = new Headers();
      const context: ApiContext = {
        ...contextFor("rest", Effect.succeed(Context.merge(services({}), real))),
        "effect/context": yield* Effect.context<never>(),
        answerCache: memory.cache,
        resHeaders,
      };
      const page = yield* Effect.promise(() =>
        createRouterClient(router, { context })
          .stars(input)
          .catch((error: unknown) => error),
      );
      return { page, cache: resHeaders.get("x-answer-cache"), cacheControl: resHeaders.get("cache-control") };
    });
});

it.layer(TestDatabase.layerMemory({ embeddingModel: "test/model" as EmbeddingModelId }), { timeout: 30_000 })(
  "public stars",
  (it) => {
    it.effect("pages a login's stars newest first through a cursor, and caches each page for 10 seconds", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const { id, type, login, name, avatarUrl, followers, publicRepos } = ada.account;
        yield* db.accounts.upsert({ id, type, login, name, avatarUrl, followers, publicRepos });
        yield* db.repos.upsertRefs(
          [501, 502, 503, 504].map((repoId) => ({
            id: repoId as RepoId,
            nodeId: `R_${repoId}` as RepoNodeId,
            owner: "owner" as Login,
            name: `repo-${repoId}` as RepoName,
          })),
        );
        yield* db.stars.upsert({
          accountId: id,
          stars: [
            starAt(501, "2026-01-01T00:00:00Z"),
            starAt(502, "2026-02-01T00:00:00Z"),
            starAt(503, "2026-03-01T00:00:00Z"),
          ],
        });
        const stars = yield* starsApi;

        const first = yield* stars({ login: "ADA", limit: 2 });
        expect(first).toMatchObject({ cache: "miss", cacheControl: "public, max-age=10" });
        expect(first.page).toMatchObject({
          login: "ada",
          repos: [
            { id: 503, starredAt: "2026-03-01T00:00:00.000Z", read: false },
            { id: 502, starredAt: "2026-02-01T00:00:00.000Z" },
          ],
          nextCursor: `${Date.parse("2026-02-01T00:00:00Z")}-502`,
        });
        const cursor = (first.page as { readonly nextCursor: string }).nextCursor;
        expect((yield* stars({ login: "ada", limit: 2, cursor })).page).toMatchObject({
          repos: [{ id: 501 }],
          nextCursor: null,
        });

        yield* db.stars.upsert({ accountId: id, stars: [starAt(504, "2026-04-01T00:00:00Z")] });
        yield* TestClock.adjust("9 seconds");
        const cached = yield* stars({ login: "ada", limit: 2 });
        expect([cached.cache, cached.page]).toEqual(["hit", first.page]);
        yield* TestClock.adjust("2 seconds");
        const next = yield* stars({ login: "ada", limit: 2 });
        expect(next.cache).toBe("miss");
        expect(
          (next.page as { readonly repos: ReadonlyArray<{ readonly id: number }> }).repos.map((repo) => repo.id),
        ).toEqual([504, 503]);
      }),
    );

    it.effect("says when Stargrep has not synced the login, and refuses a cursor it never issued", () =>
      Effect.gen(function* () {
        const stars = yield* starsApi;
        const unsynced = yield* stars({ login: "nobody-synced" });
        expect(unsynced.page).toMatchObject({ code: "ACCOUNT_NOT_SYNCED", data: traceData });
        expect(unsynced.cacheControl).toBeNull();
        expect((yield* stars({ login: "ada", cursor: "1700000000000-0" })).page).toMatchObject({ code: "BAD_REQUEST" });
      }),
    );
  },
);
