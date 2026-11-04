import { env, exports } from "cloudflare:workers";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";
import type { ApiServices } from "@stargrep/api/router";
import { SearchCache } from "@stargrep/core/search";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { layerSearchCache } from "../src/server/adapters.ts";
import { makeServer } from "../src/server/serve.ts";
import { queue } from "./entry.ts";

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

let mcpId = 0;

const mcp = async (method: string, params: object) => {
  const response = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method, params }),
  });
  return parseJsonOrEvent(await response.text()).result;
};

const tool = (name: string, args: object) => mcp("tools/call", { name, arguments: args });

const post = (input: object): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input),
});

const searchRest = (input: object) => rest("/search", post(input));

const terminalDashboards = { login: "ada", q: "terminal dashboards" };

describe("search", () => {
  it("answers over REST with ranked repos, reason lines, and a server timing", async () => {
    const { status, body, timing } = await searchRest(terminalDashboards);
    expect(status).toBe(200);
    expect(body.planSource).toBe("fallback");
    expect(body.results.map((result: { reason: string }) => result.reason)).toEqual([
      "keyword match #1, meaning match #2, 18K stars",
    ]);
    expect(timing).toMatch(/^total;dur=\d+/);
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

  it("rejects an empty query with 400 over REST and isError over MCP", async () => {
    const { status, body } = await searchRest({ login: "ada", q: "" });
    expect([status, body.code]).toEqual([400, "BAD_REQUEST"]);
    expect((await tool("search", { login: "ada", q: "" })).isError).toBe(true);
  });

  it("maps domain errors to a stable code and a trace ID, without internal detail", async () => {
    const unsynced = await searchRest({ login: "grace", q: "dashboards" });
    expect(unsynced.status).toBe(404);
    expect(unsynced.body).toEqual({
      defined: true,
      code: "ACCOUNT_NOT_SYNCED",
      message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
      data: { traceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
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
  const serve = makeServer(() => failing, Layer.empty);
  const send = async (path: string, init?: RequestInit) => {
    const response = await serve(new Request(`http://web${path}`, init));
    if (response === undefined) throw new Error(`no route for ${path}`);
    return { status: response.status, body: parseJsonOrEvent(await response.text()) };
  };

  it("still validates input and lists tools, and fails a search with service unavailable", async () => {
    expect((await send("/api/search", post({ login: "ada", q: "" }))).status).toBe(400);
    const down = await send("/api/search", post({ login: "ada", q: "dashboards" }));
    expect([down.status, down.body.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(down.body.data.traceId).toMatch(/^[0-9a-f]{32}$/);
    const listed = await send("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(listed.body.result.tools).toHaveLength(4);
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
    expect(queue.sent).toEqual([{ login: "octocat", mode: "incremental" }]);

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++)
      statuses.push((await rest("/sync/octocat", from("192.0.2.1"))).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await rest("/sync/octocat", from("192.0.2.2"))).status).toBe(202);
    expect((await rest("/sync/octocat")).body).toMatchObject({ state: "queued" });
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
