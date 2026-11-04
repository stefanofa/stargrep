import { describe, expect, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncQueue, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { Transport } from "./middleware/instrumentation.ts";
import { ApiServicesUnavailable, router } from "./router.ts";
import { SyncLimiter } from "./sync-limiter.ts";

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
};

const account = { id: 7 as GitHubAccountId, login: "ada" as Login };

interface Fakes {
  readonly search?: (request: Search.SearchRequest) => Effect.Effect<Search.SearchOutcome, Search.SearchError>;
  readonly allow?: boolean;
  readonly sent?: Array<Login>;
}

const searchOutcome = (request: Search.SearchRequest): Search.SearchOutcome => ({
  plan: QueryPlan.asTyped(request.query, "sentence"),
  planSource: "fallback",
  results: [{ repo, nameMatch: false, textRank: 2, vectorRank: 1, metrics: [{ metric: "stars", value: 18_000 }] }],
});

const services = (fakes: Fakes) => {
  const db = {
    accounts: {
      byLogin: (login: Login) =>
        Effect.succeed(login === account.login ? Option.some({ ...account, starsSyncedAt: null }) : Option.none()),
    },
    repos: { get: (id: RepoId) => Effect.succeed(id === repo.id ? Option.some(repo) : Option.none()) },
  } as unknown as Db.Db["Service"];
  const requests = SyncRequests.SyncRequests.of({
    request: (login) =>
      Effect.sync(() => {
        fakes.sent?.push(login);
        return { state: "queued", requestedAt: pushedAt, syncedAt: null };
      }),
    status: () => Effect.succeed({ state: "done", syncedAt: pushedAt }),
  });
  return Context.make(Db.Db, db).pipe(
    Context.add(
      Search.Search,
      Search.Search.of({
        search: (request) =>
          (fakes.search ?? ((r) => Effect.succeed(searchOutcome(r))))(request).pipe(Effect.withSpan("Search.search")),
      }),
    ),
    Context.add(SyncRequests.SyncRequests, requests),
    Context.add(SyncLimiter, SyncLimiter.of({ allow: Effect.succeed(fakes.allow ?? true) })),
  );
};

const client = (fakes: Fakes = {}, transport: Transport = "rpc") => {
  const collected = collectSpans();
  const context = Context.make(Tracer.Tracer, collected.tracer);
  return {
    collected,
    api: createRouterClient(router, {
      context: { "effect/context": context, transport, services: Effect.succeed(services(fakes)) },
    }),
  };
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

describe("search", () => {
  test("returns ranked repos with reason lines and ISO times", async () => {
    const { api } = client();
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
          reason: "keyword match #2, meaning match #1, 18K stars",
          metrics: [{ metric: "stars", value: 18_000 }],
        },
      ],
    });
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
      { scope: { _tag: "stars", accountId: account.id }, query: "terminal dashboards", limit: 20 },
    ]);
  });

  test("rejects an empty query and a login GitHub would not issue", async () => {
    const { api } = client();
    for (const input of [
      { login: "ada", q: "   " },
      { login: "ada/../../repos", q: "dashboards" },
      { login: "ada", q: "dashboards", limit: 500 },
    ]) {
      const error = await failure(api.search(input));
      expect(error.code).toBe("BAD_REQUEST");
    }
  });

  test("says the login is not synced, with a trace ID", async () => {
    const { api } = client();
    const error = await failure(api.search({ login: "grace", q: "dashboards" }));
    expect(error.toJSON()).toEqual({
      defined: true,
      code: "ACCOUNT_NOT_SYNCED",
      message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
      data: { traceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
  });

  test("maps an unavailable scope and a database failure to wire errors without their detail", async () => {
    const unavailable = client({
      search: (request) =>
        Effect.fail(
          new Search.SearchScopeUnavailable({ scope: request.scope._tag === "global" ? "global" : "network" }),
        ),
    });
    expect((await failure(unavailable.api.search({ login: "ada", q: "x", scope: "network" }))).code).toBe(
      "SCOPE_UNAVAILABLE",
    );
    expect((await failure(unavailable.api.search({ login: "nobody", q: "x", scope: "global" }))).code).toBe(
      "SCOPE_UNAVAILABLE",
    );

    const broken = client({
      search: () => Effect.fail(new DbQueryFailed({ operation: "search.hybrid", reason: "transport", sqlState: null })),
    });
    const error = await failure(broken.api.search({ login: "ada", q: "x" }));
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
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
  test("queues a sync and reports its status", async () => {
    const sent: Array<Login> = [];
    const { api } = client({ sent });
    expect(await api.triggerSync({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "queued",
      requestedAt: "2026-10-01T08:00:00.000Z",
      syncedAt: null,
    });
    expect(sent).toEqual(["octocat" as Login]);
    expect(await api.syncStatus({ login: "octocat" })).toEqual({
      login: "octocat",
      state: "done",
      requestedAt: null,
      syncedAt: "2026-10-01T08:00:00.000Z",
    });
  });

  test("refuses a caller over the rate limit without queueing", async () => {
    const sent: Array<Login> = [];
    const { api } = client({ sent, allow: false });
    expect((await failure(api.triggerSync({ login: "octocat" }))).code).toBe("TOO_MANY_REQUESTS");
    expect(sent).toEqual([]);
  });
});

describe("getRepo", () => {
  test("returns a stored repo and says when there is none", async () => {
    const { api } = client();
    expect(await api.getRepo({ id: 42 as RepoId })).toMatchObject({
      id: 42,
      url: "https://github.com/ratatui/ratatui",
      pushedAt: "2026-10-01T08:00:00.000Z",
    });
    expect((await failure(api.getRepo({ id: 43 as RepoId }))).code).toBe("REPO_NOT_FOUND");
  });
});

test("validates input without starting the services, and maps a failed start to service unavailable", async () => {
  let starts = 0;
  const api = createRouterClient(router, {
    context: {
      "effect/context": Context.empty(),
      transport: "rest",
      services: Effect.suspend(() => {
        starts++;
        return Effect.fail(new ApiServicesUnavailable({ failure: "DbQueryFailed" }));
      }),
    },
  });
  expect((await failure(api.search({ login: "ada", q: " " }))).code).toBe("BAD_REQUEST");
  expect(starts).toBe(0);
  const error = await failure(api.search({ login: "ada", q: "dashboards" }));
  expect(error.toJSON()).toMatchObject({ code: "SERVICE_UNAVAILABLE", data: { traceId: expect.any(String) } });
  expect(starts).toBe(1);
});

test("sync queue failures surface as service unavailable", async () => {
  const context = services({}).pipe(
    Context.add(
      SyncRequests.SyncRequests,
      SyncRequests.SyncRequests.of({
        request: () => Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "down" })),
        status: () => Effect.succeed({ state: "unknown" }),
      }),
    ),
  );
  const api = createRouterClient(router, {
    context: { "effect/context": Context.empty(), transport: "rest", services: Effect.succeed(context) },
  });
  expect((await failure(api.triggerSync({ login: "octocat" }))).code).toBe("SERVICE_UNAVAILABLE");
});
