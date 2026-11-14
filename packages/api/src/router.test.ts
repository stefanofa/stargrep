import { describe, expect, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import { QueryPlan, Search } from "@stargrep/core/search";
import { OwnerLookup, SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import { DbQueryFailed, RepoNotFound } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import { accountRow, makeDb, repo as repoRow } from "@stargrep/db/testing";
import { BudgetShare, GitHubAccountId, Login, RepoId, RepoName, type RepoNodeId } from "@stargrep/github/schemas";
import { SubjectId } from "@stargrep/knowledge/ids";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as AnswerCache from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import { GitHubLogin, type PublicConfig } from "./contract.ts";
import { errorStatus, type WireCode } from "./errors.ts";
import { IconHost } from "./icon-host.ts";
import type { Transport } from "./middleware/instrumentation.ts";
import { RateLimited, RateLimiter, RateLimiterUnavailable, type RateLimitKind } from "./rate-limiter.ts";
import { type ApiContext, router } from "./router.ts";
import { type ApiServices, ApiServicesUnavailable } from "./services.ts";
import { NotSignedIn, type Viewer, type ViewerError, Viewers, ViewerUnavailable } from "./viewers.ts";

const canary = "PRIVATE_QUERY_CANARY";
const pushedAt = DateTime.makeUnsafe("2026-10-01T08:00:00Z");

const repo = repoRow(RepoId.make(42), {
  owner: Login.make("ratatui"),
  name: RepoName.make("ratatui"),
  nodeId: null,
  description: "Rust library for terminal user interfaces",
  topics: ["tui"],
  language: "Rust",
  license: "MIT",
  kind: "library",
  pushedAt,
  summary: `A Rust library for dashboards. ${canary}`,
  keywords: ["tui"],
  icon: { key: "v1/git/abc.webp", source: "repo-file", plate: "dark", size: 96 },
  iconCheckedAt: pushedAt,
  ownerType: "org",
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
});

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
  readonly facets?: Partial<Db.Db["Service"]["facets"]>;
  readonly limiter?: (kind: RateLimitKind) => Effect.Effect<void, RateLimited | RateLimiterUnavailable>;
  readonly requests?: SyncRequests.SyncRequests["Service"];
  readonly sent?: Array<readonly [Login, SyncRequests.Requester]>;
  readonly viewer?: Effect.Effect<Viewer, ViewerError>;
  readonly signedIn?: Effect.Effect<Option.Option<UserId>, ViewerUnavailable>;
}

const ada: Viewer = {
  userId: UserId.make("user-ada"),
  account: accountRow(GitHubAccountId.make(7), {
    login: Login.make("ada"),
    name: "Ada",
    avatarUrl: "https://avatars.githubusercontent.com/u/7",
    claimedBy: UserId.make("user-ada"),
    starredCount: 2431,
  }),
};

const starredAt = DateTime.makeUnsafe("2025-03-14T10:00:00Z");

const searchOutcome = (request: Search.SearchRequest): Search.SearchOutcome => ({
  plan: QueryPlan.asTyped(request.query, "sentence"),
  planSource: "fallback",
  results: [{ repo, nameMatch: false, textRank: 2, vectorRank: 1, metrics: [{ metric: "stars", value: 18_000 }] }],
  applied: [],
});

const searchAda = (request: Search.SearchRequest) =>
  request.scope._tag !== "stars"
    ? Effect.fail(new Search.SearchScopeUnavailable({ scope: request.scope._tag }))
    : request.scope.login === "ada"
      ? Effect.succeed(searchOutcome(request))
      : Effect.fail(new Search.AccountNotSynced({ login: request.scope.login }));

const reading = { total: 1776, read: 412, failed: 3 };

const services = (fakes: Fakes): Context.Context<ApiServices> => {
  const db = makeDb({
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
    ...(fakes.facets === undefined ? {} : { facets: fakes.facets }),
  });
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
    Context.add(RateLimiter, RateLimiter.of({ acquire: fakes.limiter ?? (() => Effect.void) })),
    Context.add(
      Viewers,
      Viewers.of({
        current: fakes.viewer ?? Effect.fail(new NotSignedIn()),
        signedIn: fakes.signedIn ?? Effect.succeedNone,
      }),
    ),
    Context.add(IconHost, IconHost.of({ origin: "https://stargrep.test" })),
    Context.add(Caller, Caller.of({ key: Db.CallerKey.make("caller-test"), address: "192.0.2.1" })),
  );
};

const publicConfig: PublicConfig = {
  demoLogin: GitHubLogin.make("ada"),
  demoQuery: "terminal dashboards",
  examples: ["postgres for ai agents"],
  featured: [GitHubLogin.make("ada")],
};

// Runs a background refresh before it returns, with services of its own, so a TestClock test sees what it stored.
const runNow: ApiContext["background"] = (run) => run;

const contextFor = (
  transport: Transport,
  servicesEffect: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>,
  tracer: Tracer.Tracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
): ApiContext => ({
  "effect/context": Context.make(Tracer.Tracer, tracer),
  transport,
  publicConfig,
  procedureTime: Ref.makeUnsafe(Option.none()),
  serviceLayer: Layer.unwrap(Effect.map(servicesEffect, Layer.succeedContext)),
  execution: "request",
  answerCache: AnswerCache.disabled,
  background: runNow,
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
    expect(await api.search({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" })).toEqual({
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
          facets: [],
          reason: "keyword match #2, meaning match #1, 18K stars",
          rankedBy: ["18K stars"],
          metrics: [{ metric: "stars", value: 18_000 }],
        },
      ],
      applied: [],
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
    await api.search({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" });
    expect(requests).toEqual([
      { scope: { _tag: "stars", login: "ada" as Login }, query: "terminal dashboards", limit: 20, filter: { all: [] } },
    ]);
  });

  test("rejects an empty query and a login GitHub would not issue, with the issues and a trace ID", async () => {
    const { api } = client();
    for (const [input, ...path] of [
      [{ scope: { kind: "stars", login: "ada" }, q: "   " }, "q"],
      [{ scope: { kind: "stars", login: "ada/../../repos" }, q: "dashboards" }, "scope", "login"],
      [{ scope: { kind: "stars", login: "ada" }, q: "dashboards", limit: 500 }, "limit"],
    ] as const) {
      const error = await failure(api.search(input));
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.data).toEqual({ issues: [expect.objectContaining({ path })], ...traceData });
    }
  });

  test("maps every search failure through the error table with a trace ID and no detail", async () => {
    const { api } = client();
    expect((await failure(api.search({ scope: { kind: "stars", login: "grace" }, q: "dashboards" }))).toJSON()).toEqual(
      {
        defined: true,
        code: "ACCOUNT_NOT_SYNCED",
        message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
        data: traceData,
      },
    );

    const broken = client({
      search: () => Effect.fail(new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null })),
    });
    const error = await failure(broken.api.search({ scope: { kind: "stars", login: "ada" }, q: "x" }));
    expect(error.toJSON()).toMatchObject({ defined: true, code: "SERVICE_UNAVAILABLE", data: traceData });
    expect(JSON.stringify(error.toJSON())).not.toContain("search.hybrid");
  });

  test("turns a defect into an internal error with the call's trace ID", async () => {
    const { api, collected } = client({ search: () => Effect.die(new Error(`boom ${canary}`)) });
    const error = await failure(api.search({ scope: { kind: "stars", login: "ada" }, q: "x" }));
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(error.toJSON())).not.toContain(canary);
    expect(error.data).toEqual({ traceId: collected.named("Api.search")?.traceId });
  });

  test("opens one span per call, with no query text or result in any span", async () => {
    const { api, collected } = client({}, "mcp");
    await api.search({ scope: { kind: "stars", login: "ada" }, q: `dashboards ${canary}` });
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
  test("accepts real legacy GitHub logins at the API input boundary", async () => {
    const { api } = client();
    for (const login of ["Nek-", "john--", "foo--bar"]) {
      expect(await api.syncStatus({ login })).toMatchObject({ login, state: "failed" });
    }
  });

  test("queues a signed-in import as that user's work, and a broken session as a signed-out one", async () => {
    const sent: Array<readonly [Login, SyncRequests.Requester]> = [];
    const caller = Db.CallerKey.make("caller-test");
    const userId = UserId.make("user-ada");
    await client({ sent, signedIn: Effect.succeedSome(userId) }).api.triggerSync({ login: "octocat" });
    await client({ sent, signedIn: Effect.fail(new ViewerUnavailable({ step: "session" })) }).api.triggerSync({
      login: "hubot",
    });
    expect(sent).toEqual([
      ["octocat" as Login, { _tag: "signed-in", userId, caller }],
      ["hubot" as Login, { _tag: "anyone", caller }],
    ]);
  });

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

  test("refuses a caller over the sync limit without queueing", async () => {
    const sent: Array<readonly [Login, SyncRequests.Requester]> = [];
    const asked: Array<RateLimitKind> = [];
    const limited = client({
      sent,
      limiter: (kind) =>
        Effect.sync(() => asked.push(kind)).pipe(Effect.andThen(new RateLimited({ limit: "network" }))),
    });
    expect((await failure(limited.api.triggerSync({ login: "octocat" }))).code).toBe("TOO_MANY_REQUESTS");
    expect([asked, sent]).toEqual([["sync"], []]);
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

describe("atoms", () => {
  const facets: ReadonlyArray<Db.HeldAtom> = [
    { atom: "kind:library", label: "library", listed: true, repoId: null },
    { atom: "about:subject:4127", label: "TUI", listed: true, repoId: null },
    { atom: "trait:subject:9001", label: "one repo's concept", listed: false, repoId: null },
    { atom: "alt:subject:9310", label: "ratatui", repoId: 552_661_142 as RepoId, listed: true },
  ];
  const held = { held: () => Effect.succeed(new Map([[repo.id, facets]])) };

  test("passes the caller's filter to search and refuses one that names no atom before any work", async () => {
    const requests: Array<Search.SearchRequest> = [];
    const { api } = client({
      search: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return searchOutcome(request);
        }),
    });
    await api.search({ scope: { kind: "stars", login: "ada" }, q: "dashboards", filter: "lang:rust -kind:list" });
    expect(requests.map((request) => request.filter)).toEqual([
      {
        all: [
          { negate: false, any: [{ role: "any", value: { dim: "language", id: "rust" } }] },
          { negate: true, any: [{ role: "any", value: { dim: "kind", id: "list" } }] },
        ],
      },
    ]);
    const nine = Array.from({ length: 9 }, (_, n) => `subject:${n + 1}`);
    for (const filter of ["lang:klingon", "subject:007", "kind:", nine.join(" "), nine.join("|")]) {
      const error = await failure(api.search({ scope: { kind: "stars", login: "ada" }, q: "dashboards", filter }));
      expect([error.code, error.data]).toEqual([
        "BAD_REQUEST",
        { issues: [expect.objectContaining({ path: expect.arrayContaining(["filter"]) })], ...traceData },
      ]);
    }
    expect(requests).toHaveLength(1);
  });

  test("answers bad request when the filter names a subject that is missing, private, or rejected", async () => {
    const { api } = client({
      search: () => Effect.fail(new Search.FacetUnavailable({ subjects: [SubjectId.make(77)] })),
    });
    const error = await failure(
      api.search({ scope: { kind: "stars", login: "ada" }, q: "chat", filter: "subject:77" }),
    );
    expect([error.code, error.data]).toEqual(["BAD_REQUEST", traceData]);
  });

  test("passes the filter sorted and without repeats, so applied never depends on which request filled the cache", async () => {
    const requests: Array<Search.SearchRequest> = [];
    const { api } = client({
      search: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return searchOutcome(request);
        }),
    });
    const scope = { kind: "stars", login: "ada" } as const;
    await api.search({ scope, q: "dashboards", filter: "-kind:list lang:rust|lang:rust" });
    await api.search({ scope, q: "dashboards", filter: "lang:rust -kind:list" });
    expect(requests.map((request) => request.filter)).toEqual([
      {
        all: [
          { negate: false, any: [{ role: "any", value: { dim: "language", id: "rust" } }] },
          { negate: true, any: [{ role: "any", value: { dim: "kind", id: "list" } }] },
        ],
      },
      requests[0]?.filter,
    ]);
  });

  test("returns each result's atoms and every atom the search applied, saying which filter relaxed", async () => {
    const applied: Search.SearchOutcome["applied"] = [
      { atom: "lang:rust", label: "Rust", mode: "filter", from: "filter", span: null, relaxed: false },
      { atom: "for:subject:812", label: "PostgreSQL", mode: "boost", from: "query", span: [23, 31], relaxed: true },
    ];
    const { api } = client({
      facets: held,
      search: (request) => Effect.succeed({ ...searchOutcome(request), applied }),
    });
    const answer = await api.search({ scope: { kind: "stars", login: "ada" }, q: "rust TUI libraries for postgres" });
    expect(answer.results.map((result) => result.facets)).toEqual([facets]);
    expect(answer.applied).toEqual(applied);
  });

  test("shows the panel every atom the repo holds, a subject only it holds included", async () => {
    const { api } = client({ facets: held });
    expect((await api.getRepo({ id: 42 as RepoId })).facets).toEqual(facets);
    expect((await api.getRepo({ id: 44 as RepoId })).facets).toEqual([]);
  });

  test("lists the library's matching atoms per repo with one label for each", async () => {
    const { api } = client({
      viewer: Effect.succeed(ada),
      facets: {
        matching: () =>
          Effect.succeed({
            atoms: new Map([[repo.id, ["kind:library", "lang:rust", "subject:4127"]]]),
            labels: { "kind:library": "library", "lang:rust": "Rust", "subject:4127": "TUI" },
          }),
      },
    });
    const library = await api.library();
    expect([library.repos.map((each) => each.atoms), library.labels]).toEqual([
      [["kind:library", "lang:rust", "subject:4127"]],
      { "kind:library": "library", "lang:rust": "Rust", "subject:4127": "TUI" },
    ]);
  });

  test("looks facets up by name with a default limit, and refuses a blank name before any work", async () => {
    const asked: Array<{ readonly q: string; readonly limit: number }> = [];
    const found = [{ atom: "subject:812", label: "PostgreSQL", repos: 1840 }];
    const { api } = client({
      facets: {
        lookup: (input) =>
          Effect.sync(() => {
            asked.push(input);
            return found;
          }),
      },
    });
    expect(await api.lookupFacets({ q: "postg" })).toEqual({ facets: found });
    expect(await api.lookupFacets({ q: "postg", limit: 3 })).toEqual({ facets: found });
    expect((await failure(api.lookupFacets({ q: "  " }))).code).toBe("BAD_REQUEST");
    expect(asked).toEqual([
      { q: "postg", limit: 10 },
      { q: "postg", limit: 3 },
    ]);
  });
});

describe("signed-in procedures", () => {
  test("enforces session metadata even when the procedure has another path", async () => {
    const { context } = client();
    const api = createRouterClient({ renamed: router.library, viewer: router.config }, { context });
    expect((await failure(api.renamed())).code).toBe("UNAUTHORIZED");
    expect(await api.viewer()).toEqual(publicConfig);
  });

  test("refuse a caller with no session", async () => {
    const { api } = client();
    for (const call of [api.viewer(), api.library()]) {
      const error = await failure(call);
      expect([error.code, error.data]).toEqual(["UNAUTHORIZED", traceData]);
    }
  });

  test("return the signed-in account and its stars, newest first", async () => {
    const sent: Array<readonly [Login, SyncRequests.Requester]> = [];
    const { api } = client({ viewer: Effect.succeed(ada), sent });
    expect(await api.viewer()).toEqual({
      login: "ada",
      name: "Ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      starredCount: 2431,
    });
    expect(sent).toEqual([["ada" as Login, { _tag: "owner", userId: ada.userId }]]);
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
          atoms: [],
        }),
      ],
      labels: {},
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
  yield* db.accounts.recordStarSync({ accountId: id, at: lastSync });
});

const signedInWith = (sender: Layer.Layer<SyncQueue.SyncQueue>) =>
  SyncRequests.layer(BudgetShare.make(0.5)).pipe(
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
        {
          login: ada.account.login,
          mode: "incremental",
          requestedAt: DateTime.makeUnsafe(now),
          reserved: 0,
          userId: ada.userId,
        },
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
      yield* Db.Db.use((db) => db.accounts.recordStarSync({ accountId: ada.account.id, at: finished }));
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
  expect((await failure(api.search({ scope: { kind: "stars", login: "ada" }, q: " " }))).code).toBe("BAD_REQUEST");
  expect(starts).toBe(0);
  const error = await failure(api.search({ scope: { kind: "stars", login: "ada" }, q: "dashboards" }));
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
  const memory = AnswerCache.memory();
  const call = (
    input: {
      readonly scope: { readonly kind: "stars"; readonly login: string };
      readonly q: string;
      readonly filter?: string;
    },
    servicesEffect: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable> = built,
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
      expect(yield* demo.call({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" })).toMatchObject({
        cache: "miss",
        stars: 1,
      });
      expect(
        yield* demo.call({ scope: { kind: "stars", login: "ADA" }, q: "  Terminal   dashboards " }, noServices),
      ).toMatchObject({
        cache: "hit",
        stars: 1,
      });
      expect([demo.searched.length, demo.builds()]).toEqual([1, 1]);
      expect([...demo.memory.entries.keys()]).toEqual(["search/ada/stars/20//terminal dashboards"]);
    }),
  );

  it.effect("never serves a filtered search the unfiltered answer, and shares one answer per normalized filter", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      const query = { scope: { kind: "stars" as const, login: "ada" }, q: "terminal dashboards" };
      expect((yield* demo.call(query)).cache).toBe("miss");
      expect((yield* demo.call({ ...query, filter: "lang:rust -kind:list" })).cache).toBe("miss");
      expect((yield* demo.call({ ...query, filter: "-kind:list lang:rust" }, noServices)).cache).toBe("hit");
      expect((yield* demo.call({ ...query, filter: "" }, noServices)).cache).toBe("hit");
      expect(demo.searched.map((request) => request.filter?.all.length)).toEqual([0, 2]);
      expect([...demo.memory.entries.keys()]).toEqual([
        "search/ada/stars/20//terminal dashboards",
        "search/ada/stars/20/lang:rust -kind:list/terminal dashboards",
      ]);
    }),
  );

  it.effect("forgets a filtered answer once its subject is rejected, so the next request answers bad request", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      const query = { scope: { kind: "stars" as const, login: "ada" }, q: "chat apps", filter: "subject:77" };
      expect((yield* demo.call(query)).cache).toBe("miss");
      yield* TestClock.adjust("6 minutes");
      const rejected = Effect.succeed(
        services({ search: () => Effect.fail(new Search.FacetUnavailable({ subjects: [SubjectId.make(77)] })) }),
      );
      expect((yield* demo.call(query, rejected)).cache).toBe("stale");
      expect(demo.memory.entries.size).toBe(0);
      const exit = yield* Effect.exit(demo.call(query, rejected));
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toMatchObject({ code: "BAD_REQUEST" });
    }),
  );

  it.effect("keeps serving a stale answer when its refresh fails with an outage", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      const query = { scope: { kind: "stars" as const, login: "ada" }, q: "chat apps", filter: "lang:rust" };
      expect((yield* demo.call(query)).cache).toBe("miss");
      yield* TestClock.adjust("6 minutes");
      const down = Effect.succeed(
        services({
          search: () =>
            Effect.fail(new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null })),
        }),
      );
      expect((yield* demo.call(query, down)).cache).toBe("stale");
      expect(demo.memory.entries.size).toBe(1);
      expect((yield* demo.call(query, down)).cache).toBe("stale");
    }),
  );

  it.effect("never stores an answer the planner could not plan", () =>
    Effect.gen(function* () {
      const demo = demoSearch("fallback");
      const query = { scope: { kind: "stars" as const, login: "ada" }, q: "terminal dashboards" };
      expect((yield* demo.call(query)).cache).toBe("miss");
      expect((yield* demo.call(query)).cache).toBe("miss");
      expect([demo.searched.length, demo.memory.entries.size]).toEqual([2, 0]);
    }),
  );

  it.effect("never caches another login's search", () =>
    Effect.gen(function* () {
      const demo = demoSearch();
      const query = { scope: { kind: "stars" as const, login: "grace" }, q: "terminal dashboards" };
      expect((yield* demo.call(query)).cache).toBeNull();
      expect((yield* demo.call(query)).cache).toBeNull();
      expect([demo.searched.length, demo.memory.entries.size]).toEqual([2, 0]);
    }),
  );

  it.effect("takes from the network's search limit only when a search runs, never for a cached demo answer", () =>
    Effect.gen(function* () {
      const acquired: Array<RateLimitKind> = [];
      let refuse = false;
      const limiter = (kind: RateLimitKind) =>
        Effect.suspend(() => {
          acquired.push(kind);
          return refuse ? Effect.fail(new RateLimited({ limit: "network" })) : Effect.void;
        });
      const demo = demoSearch();
      const planned = (request: Search.SearchRequest) =>
        Effect.succeed({ ...searchOutcome(request), planSource: "model" as const });
      const limited = Effect.succeed(services({ search: planned, limiter }));
      yield* demo.call({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" }, limited);
      refuse = true;
      expect(
        (yield* demo.call({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" }, limited)).cache,
      ).toBe("hit");
      expect(acquired).toEqual(["search"]);
      const error = yield* Effect.promise(() =>
        failure(client({ limiter }).api.search({ scope: { kind: "stars", login: "ada" }, q: "other words" })),
      );
      expect([error.code, acquired]).toEqual(["TOO_MANY_REQUESTS", ["search", "search"]]);
    }),
  );
});

describe("rate limits", () => {
  test("answer a refusal with 429 and a limiter outage with 503, for every limited procedure", async () => {
    const calls = (api: ReturnType<typeof client>["api"]) => [
      api.search({ scope: { kind: "stars", login: "grace" }, q: "x" }),
      api.triggerSync({ login: "octocat" }),
      api.stars({ login: "grace" }),
      api.lookupFacets({ q: "rust" }),
    ];
    const refused = client({ limiter: () => Effect.fail(new RateLimited({ limit: "all" })) });
    const down = client({ limiter: () => Effect.fail(new RateLimiterUnavailable({ cause: "down" })) });
    for (const call of calls(refused.api)) {
      const error = await failure(call);
      expect([error.code, errorStatus[error.code as WireCode], error.data]).toEqual([
        "TOO_MANY_REQUESTS",
        429,
        traceData,
      ]);
    }
    for (const call of calls(down.api)) {
      const error = await failure(call);
      expect([error.code, errorStatus[error.code as WireCode]]).toEqual(["SERVICE_UNAVAILABLE", 503]);
    }
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
  const memory = AnswerCache.memory();
  const limits: Array<RateLimitKind> = [];
  let builds = 0;
  const built = Effect.sync(() => {
    builds++;
    return Context.merge(services({ limiter: (kind) => Effect.sync(() => limits.push(kind)) }), real);
  });
  const stars = (input: { readonly login: string; readonly limit?: number; readonly cursor?: string }) =>
    Effect.gen(function* () {
      const resHeaders = new Headers();
      const context: ApiContext = {
        ...contextFor("rest", built),
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
  return { stars, limits, memory, builds: () => builds };
});

type StarsPage = { readonly repos: ReadonlyArray<{ readonly id: number }>; readonly nextCursor: string | null };

const ids = (page: unknown) => (page as StarsPage).repos.map((repo) => repo.id);

// Replaces every star the test database holds, one a day from New Year 2026, so each test starts from its own stars.
const seedStars = (repoIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    yield* (yield* TestDatabase.TestDatabase).query("delete from stars");
    const db = yield* Db.Db;
    const { id, type, login, name, avatarUrl, followers, publicRepos } = ada.account;
    yield* db.accounts.upsert({ id, type, login, name, avatarUrl, followers, publicRepos });
    yield* db.repos.upsertRefs(
      repoIds.map((repoId) => ({
        id: repoId as RepoId,
        nodeId: `R_${repoId}` as RepoNodeId,
        owner: "owner" as Login,
        name: `repo-${repoId}` as RepoName,
      })),
    );
    yield* db.stars.upsert({
      accountId: id,
      stars: repoIds.map((repoId, index) =>
        starAt(
          repoId,
          DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000)),
        ),
      ),
    });
  });

it.layer(TestDatabase.layerMemory({ embeddingModel: "test/model" as EmbeddingModelId }), { timeout: 30_000 })(
  "public stars",
  (it) => {
    it.effect("pages a login's stars newest first through a cursor, and caches each page for 10 seconds", () =>
      Effect.gen(function* () {
        yield* seedStars([501, 502, 503]);
        const { stars } = yield* starsApi;

        const first = yield* stars({ login: "ADA", limit: 2 });
        expect(first).toMatchObject({ cache: "miss", cacheControl: "public, max-age=10" });
        expect(first.page).toMatchObject({
          login: "ada",
          repos: [
            { id: 503, starredAt: "2026-01-03T00:00:00.000Z", read: false },
            { id: 502, starredAt: "2026-01-02T00:00:00.000Z" },
          ],
          nextCursor: `${Date.parse("2026-01-02T00:00:00Z")}-502`,
        });
        const cursor = (first.page as StarsPage).nextCursor ?? "";
        expect((yield* stars({ login: "ada", limit: 2, cursor })).page).toMatchObject({
          repos: [{ id: 501 }],
          nextCursor: null,
        });

        yield* seedStars([501, 502, 503, 504]);
        yield* TestClock.adjust("9 seconds");
        const cached = yield* stars({ login: "ada", limit: 2 });
        expect([cached.cache, cached.page]).toEqual(["hit", first.page]);
        yield* TestClock.adjust("2 seconds");
        const next = yield* stars({ login: "ada", limit: 2 });
        expect([next.cache, ids(next.page)]).toEqual(["miss", [504, 503]]);
      }),
    );

    it.effect("lists only the labels of the atoms the repos it answers hold", () =>
      Effect.gen(function* () {
        yield* seedStars([601, 602]);
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query("update repos set kinds = '{cli}' where id = 602");
        yield* database.query("update repos set kinds = '{app}' where id = 601");
        const { stars } = yield* starsApi;
        const newest = (yield* stars({ login: "ada", limit: 1 })).page;
        expect(newest).toMatchObject({
          repos: [{ id: 602, kind: "cli", atoms: ["kind:cli"] }],
          labels: { "kind:cli": "CLI" },
        });
        expect(Object.keys((newest as { labels: object }).labels)).toEqual(["kind:cli"]);
        expect((yield* stars({ login: "ada", limit: 2 })).page).toMatchObject({
          labels: { "kind:cli": "CLI", "kind:app": "app" },
        });
      }),
    );

    it.effect("reads 100 stars for any limit up to 100 and 1,000 above it, so other limits hit the same page", () =>
      Effect.gen(function* () {
        yield* seedStars([601, 602, 603, 604, 605]);
        const { stars, memory } = yield* starsApi;
        const two = yield* stars({ login: "ada", limit: 2 });
        const three = yield* stars({ login: "ada", limit: 3 });
        const all = yield* stars({ login: "ada", limit: 100 });
        expect([two.cache, three.cache, all.cache]).toEqual(["miss", "hit", "hit"]);
        expect([ids(three.page), (three.page as StarsPage).nextCursor]).toEqual([
          [605, 604, 603],
          `${Date.parse("2026-01-03T00:00:00Z")}-603`,
        ]);
        expect([ids(all.page), (all.page as StarsPage).nextCursor]).toEqual([[605, 604, 603, 602, 601], null]);

        expect((yield* stars({ login: "ada", limit: 101 })).cache).toBe("miss");
        expect((yield* stars({ login: "ada" })).cache).toBe("hit");
        expect([...memory.entries.keys()]).toEqual(["stars/ada/100/", "stars/ada/1000/"]);
      }),
    );

    it.effect("takes from the network's stars limit on a miss only", () =>
      Effect.gen(function* () {
        yield* seedStars([701, 702]);
        const { stars, limits } = yield* starsApi;
        yield* stars({ login: "ada", limit: 1 });
        yield* stars({ login: "ada", limit: 2 });
        expect(limits).toEqual(["stars"]);
      }),
    );

    it.effect("says when Stargrep has not synced the login", () =>
      Effect.gen(function* () {
        const { stars } = yield* starsApi;
        const unsynced = yield* stars({ login: "nobody-synced" });
        expect(unsynced.page).toMatchObject({ code: "ACCOUNT_NOT_SYNCED", data: traceData });
        expect(unsynced.cacheControl).toBeNull();
      }),
    );

    it.effect("rejects a cursor it never issued at validation, with the issues and a trace ID, before any work", () =>
      Effect.gen(function* () {
        const { stars, limits, builds } = yield* starsApi;
        for (const cursor of ["1700000000000-0", "1700000000000", "soon-42"]) {
          const refused = (yield* stars({ login: "ada", cursor })).page as ORPCError<string, unknown>;
          expect([refused.code, refused.data]).toEqual([
            "BAD_REQUEST",
            { issues: [expect.objectContaining({ path: expect.arrayContaining(["cursor"]) })], ...traceData },
          ]);
        }
        expect([limits, builds()]).toEqual([[], 0]);
      }),
    );
  },
);
