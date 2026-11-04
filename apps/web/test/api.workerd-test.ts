import { env, exports } from "cloudflare:workers";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";
import type { ApiServices } from "@stargrep/api/router";
import { SearchCache } from "@stargrep/core/search";
import { DbQueryFailed } from "@stargrep/db/errors";
import { Login } from "@stargrep/github/schemas";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { layerSearchCache } from "../src/server/adapters.ts";
import { layerRequest } from "../src/server/layers.ts";
import { makeServer } from "../src/server/serve.ts";
import { queue, syncRequests } from "./entry.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read as untyped JSON in these tests.
type Json = any;

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://web${path}`, init));

const rest = async (path: string, init?: RequestInit) => {
  const response = await call(`/api${path}`, init);
  const body: Json = await response.json();
  return { status: response.status, body, timing: response.headers.get("server-timing") };
};

const rpc: ContractRouterClient<typeof contract> = createORPCClient(
  new RPCLink({
    url: "/rpc",
    origin: "http://web",
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
  }),
);

// The legacy MCP transport answers with one server-sent event, the modern one with plain JSON.
const parseJsonOrEvent = (text: string): Json =>
  JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6));

const post = (input: object): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(input),
});

let mcpId = 0;

const mcpCall = (method: string, params: object) => post({ jsonrpc: "2.0", id: ++mcpId, method, params });

const mcp = async (method: string, params: object) =>
  parseJsonOrEvent(await (await call("/mcp", mcpCall(method, params))).text()).result;

const tool = (name: string, args: object) => mcp("tools/call", { name, arguments: args });

const sendTo =
  (serve: (request: Request) => Promise<Response> | undefined) => async (path: string, init: RequestInit) => {
    const response = await serve(new Request(`http://web${path}`, init));
    if (response === undefined) throw new Error(`no route for ${path}`);
    return {
      status: response.status,
      traceHeader: response.headers.get("x-trace-id"),
      body: parseJsonOrEvent(await response.text()),
    };
  };

const searchRest = (input: object) => rest("/search", post(input));

const terminalDashboards = { login: "ada", q: "terminal dashboards" };

const traceId = expect.stringMatching(/^[0-9a-f]{32}$/);

const rpcFailure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: Json) => error,
  );

describe("search", () => {
  it("answers over REST with ranked repos, reason lines, and a server timing", async () => {
    const { status, body, timing } = await searchRest(terminalDashboards);
    expect(status).toBe(200);
    expect(body.planSource).toBe("fallback");
    expect(body.results.map((result: { reason: string }) => result.reason)).toEqual([
      "keyword match #1, meaning match #2, 18K stars",
    ]);
    expect(timing).toMatch(/^total;dur=\d+, api;dur=\d+$/);
  });

  it("answers the same over typed RPC and as the MCP tool's structured content", async () => {
    const { body } = await searchRest(terminalDashboards);
    expect(await rpc.search({ login: "ada", q: "terminal dashboards" })).toEqual(body);
    const result = await tool("search", { login: "ada", q: "terminal dashboards" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(body);
  });

  it("never takes the query in a URL", async () => {
    expect((await call("/api/search?login=ada&q=terminal%20dashboards")).status).toBe(404);
  });

  it("rejects an empty query with 400 and a trace ID over REST, RPC, and MCP", async () => {
    const { status, body } = await searchRest({ login: "ada", q: "" });
    expect([status, body.code]).toEqual([400, "BAD_REQUEST"]);
    expect(body.data).toEqual({ issues: [expect.objectContaining({ path: ["q"] })], traceId });

    const viaRpc = await rpcFailure(rpc.search({ login: "ada", q: "" }));
    expect([viaRpc.code, viaRpc.data.traceId]).toEqual(["BAD_REQUEST", traceId]);
    const rawRpc = await call("/rpc/search", post({ json: { login: "ada", q: "" } }));
    expect(rawRpc.status).toBe(400);

    const result = await tool("search", { login: "ada", q: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "BAD_REQUEST", data: { traceId } });
  });

  it("maps domain errors to a stable code and a trace ID, without internal detail", async () => {
    const unsynced = await searchRest({ login: "grace", q: "dashboards" });
    expect(unsynced.status).toBe(404);
    expect(unsynced.body).toEqual({
      defined: true,
      code: "ACCOUNT_NOT_SYNCED",
      message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
      data: { traceId },
    });

    const network = await searchRest({ login: "ada", q: "dashboards", scope: "network" });
    expect([network.status, network.body.code]).toEqual([422, "SCOPE_UNAVAILABLE"]);

    const down = await searchRest({ login: "ada", q: "database down" });
    expect([down.status, down.body.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(JSON.stringify(down.body)).not.toContain("search.hybrid");

    const result = await tool("search", { login: "grace", q: "dashboards" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "ACCOUNT_NOT_SYNCED",
      data: { traceId: expect.any(String) },
    });
  });
});

describe("when the services cannot start", () => {
  const failing: Layer.Layer<ApiServices, DbQueryFailed> = Layer.unwrap(
    Effect.fail(new DbQueryFailed({ operation: "settings.adopt", reason: "transport", sqlState: null })),
  );
  const send = sendTo(makeServer(() => failing, Layer.empty));

  it("still validates input and lists tools, and fails a search with service unavailable", async () => {
    expect((await send("/api/search", post({ login: "ada", q: "" }))).status).toBe(400);
    const down = await send("/api/search", post({ login: "ada", q: "dashboards" }));
    expect([down.status, down.body.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(down.body.data.traceId).toEqual(traceId);
    expect((await send("/mcp", mcpCall("tools/list", {}))).body.result.tools).toHaveLength(4);
  });
});

describe("when the database is unreachable", () => {
  const send = sendTo(makeServer((request) => layerRequest(env, Option.none(), request), Layer.empty));

  it("answers a body that is not JSON with 400 and the request's trace ID on every transport", async () => {
    const malformed: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: '{"login":',
    };
    const viaRest = await send("/api/search", malformed);
    expect(viaRest).toMatchObject({ status: 400, traceHeader: traceId, body: { code: "BAD_REQUEST" } });
    expect(viaRest.body.data.traceId).toBe(viaRest.traceHeader);

    const viaRpc = await send("/rpc/search", malformed);
    expect(viaRpc).toMatchObject({ status: 400, traceHeader: traceId, body: { json: { code: "BAD_REQUEST" } } });
    expect(viaRpc.body.json.data.traceId).toBe(viaRpc.traceHeader);

    const viaMcp = await send("/mcp", malformed);
    expect(viaMcp).toMatchObject({ status: 400, traceHeader: traceId, body: { error: { code: -32700 } } });
    expect(viaMcp.body.error.data.traceId).toBe(viaMcp.traceHeader);
  });

  it("answers service unavailable with a trace ID on every transport, and still lists tools", async () => {
    const viaRest = await send("/api/search", post({ login: "ada", q: "dashboards" }));
    expect([viaRest.status, viaRest.body.code, viaRest.body.data.traceId]).toEqual([
      503,
      "SERVICE_UNAVAILABLE",
      traceId,
    ]);

    const viaRpc = await send("/rpc/search", post({ json: { login: "ada", q: "dashboards" } }));
    expect([viaRpc.status, viaRpc.body.json.code, viaRpc.body.json.data.traceId]).toEqual([
      503,
      "SERVICE_UNAVAILABLE",
      traceId,
    ]);

    const viaMcp = await send(
      "/mcp",
      mcpCall("tools/call", { name: "search", arguments: { login: "ada", q: "dashboards" } }),
    );
    expect(viaMcp.body.result.isError).toBe(true);
    expect(JSON.parse(viaMcp.body.result.content[0].text)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { traceId },
    });

    expect((await send("/mcp", mcpCall("tools/list", {}))).body.result.tools).toHaveLength(4);
    expect(JSON.stringify([viaRest, viaRpc, viaMcp])).not.toContain("postgres://");
  });
});

describe("mcp", () => {
  it("lists every procedure as a tool with an input schema", async () => {
    const { tools } = await mcp("tools/list", {});
    expect(tools.map((each: { name: string }) => each.name).sort()).toEqual([
      "getRepo",
      "search",
      "syncStatus",
      "triggerSync",
    ]);
    const searchTool = tools.find((each: { name: string }) => each.name === "search");
    expect(searchTool.inputSchema.required).toEqual(["login", "q"]);
    expect(searchTool.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("sync", () => {
  it("queues a login once and rate limits one caller without blocking another", async () => {
    const from = (ip: string) => ({ method: "POST", headers: { "cf-connecting-ip": ip } });
    const first = await rest("/sync/octocat", from("192.0.2.1"));
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ login: "octocat", state: "queued", syncedAt: null });
    expect((await rest("/sync/octocat", from("192.0.2.1"))).body.state).toBe("queued");
    expect(queue.sent).toEqual([
      {
        login: "octocat",
        mode: "incremental",
        requestedAt: DateTime.toUtc(DateTime.makeUnsafe(first.body.requestedAt)),
      },
    ]);

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++)
      statuses.push((await rest("/sync/octocat", from("192.0.2.1"))).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await rest("/sync/octocat", from("192.0.2.2"))).status).toBe(202);
    expect((await rest("/sync/octocat")).body).toMatchObject({ state: "queued" });
  });

  it("queues one job when the same login is triggered many times at once", async () => {
    const replies = await Promise.all(
      ["192.0.2.20", "192.0.2.21", "192.0.2.22"].map((ip) =>
        rest("/sync/Swarm-Race", { method: "POST", headers: { "cf-connecting-ip": ip } }),
      ),
    );
    expect(replies.map((reply) => [reply.status, reply.body.state])).toEqual([
      [202, "queued"],
      [202, "queued"],
      [202, "queued"],
    ]);
    expect(new Set(replies.map((reply) => reply.body.requestedAt)).size).toBe(1);
    expect(queue.sent.filter((request) => request.login.toLowerCase() === "swarm-race")).toHaveLength(1);
  });

  it("reports a dead-lettered sync as failed, and ignores the dead letter of an older request", async () => {
    const queued = await rest("/sync/Hubot", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.9" } });
    expect(queued.status).toBe(202);
    const requestedAt = DateTime.toUtc(DateTime.makeUnsafe(queued.body.requestedAt));
    await Effect.runPromise(
      syncRequests.markFailed(Login.make("hubot"), DateTime.subtract(requestedAt, { minutes: 11 })),
    );
    expect((await rest("/sync/hubot")).body.state).toBe("queued");
    await Effect.runPromise(syncRequests.markFailed(Login.make("hubot"), requestedAt));
    expect((await rest("/sync/hubot")).body).toMatchObject({ login: "hubot", state: "failed", syncedAt: null });
  });

  it("rejects a login GitHub would not issue", async () => {
    expect((await rest("/sync/a..b", { method: "POST" })).status).toBe(400);
  });
});

describe("getRepo and the spec", () => {
  it("reads a repo by ID and says when there is none", async () => {
    expect((await rest("/repos/42")).body).toMatchObject({ id: 42, url: "https://github.com/ratatui/ratatui" });
    expect((await rest("/repos/43")).body.code).toBe("REPO_NOT_FOUND");
    expect((await rest("/repos/abc")).status).toBe(400);
  });

  it("lists every procedure in the OpenAPI document with only finite numbers", async () => {
    const response = await call("/openapi.json");
    const text = await response.text();
    expect(Object.keys(JSON.parse(text).paths).sort()).toEqual(["/repos/{id}", "/search", "/sync/{login}"]);
    expect(text).not.toMatch(/Infinity|NaN/);
    expect(JSON.parse(text).security).toEqual([]);
  });
});

describe("search cache on KV", () => {
  it("stores entries with an expiration of at least 60 seconds", async () => {
    const entry = SearchCache.entry({ namespace: "probe", schema: Schema.String, ttl: Duration.seconds(1) });
    const { value, now } = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* SearchCache.SearchCache;
        yield* cache.store(entry, "hello", "world");
        return { value: yield* cache.lookup(entry, "hello"), now: yield* Clock.currentTimeMillis };
      }).pipe(Effect.provide(layerSearchCache(env.SEARCH_CACHE))),
    );
    expect(value).toEqual(Option.some("world"));
    const { keys } = await env.SEARCH_CACHE.list({ prefix: "probe/" });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.expiration ?? 0).toBeGreaterThanOrEqual(Math.floor(now / 1000) + 59);
  });
});
