import { env, exports } from "cloudflare:workers";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";
import type { ApiServices } from "@stargrep/api/services";
import { SearchCache } from "@stargrep/core/search";
import { DbQueryFailed } from "@stargrep/db/errors";
import { githubLogin } from "@stargrep/github/login";
import { BudgetShare } from "@stargrep/github/schemas";
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
import { requested, waitingStart } from "./entry.ts";
import { testServer } from "./serve.ts";

const share = BudgetShare.make(0.5);

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

const terminalDashboards = { scope: { kind: "stars" as const, login: "ada" }, q: "terminal dashboards" };

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
    expect(await rpc.search({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" })).toEqual(body);
    const result = await tool("search", { scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(body);
  });

  it("never takes the query in a URL", async () => {
    expect((await call("/api/search?login=ada&q=terminal%20dashboards")).status).toBe(404);
  });

  it("rejects an empty query with 400 and a trace ID over REST, RPC, and MCP", async () => {
    const { status, body } = await searchRest({ scope: { kind: "stars", login: "ada" }, q: "" });
    expect([status, body.code]).toEqual([400, "BAD_REQUEST"]);
    expect(body.data).toEqual({ issues: [expect.objectContaining({ path: ["q"] })], traceId });

    const viaRpc = await rpcFailure(rpc.search({ scope: { kind: "stars", login: "ada" }, q: "" }));
    expect([viaRpc.code, viaRpc.data.traceId]).toEqual(["BAD_REQUEST", traceId]);
    const rawRpc = await call("/rpc/search", post({ json: { scope: { kind: "stars", login: "ada" }, q: "" } }));
    expect(rawRpc.status).toBe(400);

    const result = await tool("search", { scope: { kind: "stars", login: "ada" }, q: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "BAD_REQUEST", data: { traceId } });
  });

  it("maps domain errors to a stable code and a trace ID, without internal detail", async () => {
    const unsynced = await searchRest({ scope: { kind: "stars", login: "grace" }, q: "dashboards" });
    expect(unsynced.status).toBe(404);
    expect(unsynced.body).toEqual({
      defined: true,
      code: "ACCOUNT_NOT_SYNCED",
      message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
      data: { traceId },
    });

    const network = await searchRest({
      q: "dashboards",
      scope: { kind: "network" },
    });
    expect([network.status, network.body.code]).toEqual([400, "BAD_REQUEST"]);

    const down = await searchRest({ scope: { kind: "stars", login: "ada" }, q: "database down" });
    expect([down.status, down.body.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(JSON.stringify(down.body)).not.toContain("search.hybrid");

    const result = await tool("search", { scope: { kind: "stars", login: "grace" }, q: "dashboards" });
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
  const send = sendTo(testServer(() => failing));

  it("still validates input and lists tools, and fails a search with service unavailable", async () => {
    expect((await send("/api/search", post({ scope: { kind: "stars", login: "ada" }, q: "" }))).status).toBe(400);
    const down = await send("/api/search", post({ scope: { kind: "stars", login: "ada" }, q: "dashboards" }));
    expect([down.status, down.body.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(down.body.data.traceId).toEqual(traceId);
    expect((await send("/mcp", mcpCall("tools/list", {}))).body.result.tools).toHaveLength(10);
  });
});

describe("when the server fails outside the API", () => {
  const send = sendTo(
    testServer(() => {
      throw new Error("request layer defect");
    }),
  );

  it("answers 500 in each transport's error shape with the request's trace ID", async () => {
    const viaRest = await send("/api/search", post({ scope: { kind: "stars", login: "ada" }, q: "dashboards" }));
    expect(viaRest).toMatchObject({ status: 500, traceHeader: traceId, body: { code: "INTERNAL_SERVER_ERROR" } });
    expect(viaRest.body.data.traceId).toBe(viaRest.traceHeader);

    const viaRpc = await send(
      "/rpc/search",
      post({ json: { scope: { kind: "stars", login: "ada" }, q: "dashboards" } }),
    );
    expect(viaRpc.body.json).toMatchObject({ code: "INTERNAL_SERVER_ERROR", data: { traceId: viaRpc.traceHeader } });

    const viaMcp = await send("/mcp", mcpCall("tools/list", {}));
    expect(viaMcp).toMatchObject({
      status: 500,
      body: { error: { code: -32603, data: { traceId: viaMcp.traceHeader } } },
    });
    expect(JSONRPCMessageSchema.safeParse(viaMcp.body).success).toBe(true);
    expect(JSON.stringify([viaRest, viaRpc, viaMcp])).not.toContain("request layer defect");
  });
});

describe("when the database is unreachable", () => {
  const send = sendTo(
    testServer((request) =>
      layerRequest(
        env,
        { ai: { provider: "gateway", key: Option.none() }, budgetShare: share, auth: Option.none() },
        request,
      ),
    ),
  );

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
    const viaRest = await send("/api/search", post({ scope: { kind: "stars", login: "ada" }, q: "dashboards" }));
    expect([viaRest.status, viaRest.body.code, viaRest.body.data.traceId]).toEqual([
      503,
      "SERVICE_UNAVAILABLE",
      traceId,
    ]);

    const viaRpc = await send(
      "/rpc/search",
      post({ json: { scope: { kind: "stars", login: "ada" }, q: "dashboards" } }),
    );
    expect([viaRpc.status, viaRpc.body.json.code, viaRpc.body.json.data.traceId]).toEqual([
      503,
      "SERVICE_UNAVAILABLE",
      traceId,
    ]);

    const viaMcp = await send(
      "/mcp",
      mcpCall("tools/call", { name: "search", arguments: { scope: { kind: "stars", login: "ada" }, q: "dashboards" } }),
    );
    expect(viaMcp.body.result.isError).toBe(true);
    expect(JSON.parse(viaMcp.body.result.content[0].text)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { traceId },
    });

    expect((await send("/mcp", mcpCall("tools/list", {}))).body.result.tools).toHaveLength(10);
    expect(JSON.stringify([viaRest, viaRpc, viaMcp])).not.toContain("postgres://");
  });
});

describe("lookupFacets", () => {
  it("takes the name in a POST body, never a URL, and answers the same as an MCP tool", async () => {
    expect((await call("/api/facets?q=postg")).status).toBe(404);
    const viaRest = await rest("/facets", post({ q: "postg", limit: 1 }));
    expect([viaRest.status, viaRest.body]).toEqual([
      200,
      { facets: [{ atom: "subject:812", label: "PostgreSQL", repos: 1840 }] },
    ]);
    const viaMcp = await tool("lookupFacets", { q: "postg" });
    expect(viaMcp.structuredContent.facets).toHaveLength(2);
  });
});

describe("mcp", () => {
  it("lists every procedure as a tool with an input schema", async () => {
    const { tools } = await mcp("tools/list", {});
    expect(tools.map((each: { name: string }) => each.name).sort()).toEqual([
      "config",
      "getRepo",
      "lookupFacets",
      "people",
      "search",
      "similarPeople",
      "similarRepos",
      "stars",
      "syncStatus",
      "triggerSync",
    ]);
    const searchTool = tools.find((each: { name: string }) => each.name === "search");
    expect(searchTool.inputSchema.required).toEqual(["q", "scope"]);
    expect(searchTool.annotations).toMatchObject({ readOnlyHint: true });
    const lookupTool = tools.find((each: { name: string }) => each.name === "lookupFacets");
    expect([lookupTool.inputSchema.required, lookupTool.annotations]).toEqual([["q"], { readOnlyHint: true }]);
  });

  it("passes atoms as one string, with no enum of subjects anywhere in the tool list", async () => {
    const { tools } = await mcp("tools/list", {});
    const filter = tools.find((each: { name: string }) => each.name === "search").inputSchema.properties.filter;
    expect(filter).toMatchObject({ type: "string", maxLength: 2000 });
    expect(filter).not.toHaveProperty("enum");
    const enums: Array<ReadonlyArray<unknown>> = [];
    JSON.stringify(tools, (key, value) => {
      if (key === "enum") enums.push(value);
      return value;
    });
    expect(enums.flat().filter((value) => String(value).includes("subject"))).toEqual([]);
  });
});

describe("sync", () => {
  const from = (ip: string) => ({ method: "POST", headers: { "cf-connecting-ip": ip } });

  it("asks admission for anyone's sync under the network's key, and limits one network without blocking another", async () => {
    const first = await rest("/sync/octocat", from("192.0.2.1"));
    expect([first.status, first.body]).toEqual([
      202,
      expect.objectContaining({ login: "octocat", state: "queued", syncedAt: null, waiting: null }),
    ]);
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt++)
      statuses.push((await rest("/sync/octocat", from("192.0.2.1"))).status);
    expect(statuses).toEqual([202, 202, 202, 202, 429]);
    expect((await rest("/sync/octocat", from("192.0.2.2"))).status).toBe(202);

    const callers = requested.filter((request) => request.login === "octocat").map((request) => request.by);
    expect(callers).toHaveLength(6);
    expect(callers.every((by) => by._tag === "anyone" && /^[0-9a-f]{32}$/.test(by.caller))).toBe(true);
    expect(new Set(callers.map((by) => (by._tag === "anyone" ? by.caller : "")))).toHaveProperty("size", 2);
  });

  it("answers what admission refuses with each refusal's status and a trace ID", async () => {
    const cases = [
      ["ghost-login", 404, "LOGIN_NOT_FOUND"],
      ["budget-spent", 503, "SYNC_BUSY"],
      ["line-full", 503, "SYNC_BUSY"],
      ["github-down", 503, "SERVICE_UNAVAILABLE"],
    ] as const;
    for (const [login, status, code] of cases) {
      const refused = await rest(`/sync/${login}`, from("192.0.2.30"));
      expect([refused.status, refused.body.code, refused.body.data.traceId]).toEqual([status, code, traceId]);
    }
  });

  it("reports a sync waiting in line with its place and start, and an org done with a starred total of 0", async () => {
    expect((await rest("/sync/Patient", from("192.0.2.33"))).body).toMatchObject({
      login: "Patient",
      state: "waiting",
      waiting: { ahead: 2, startsAt: DateTime.formatIso(waitingStart) },
      starredTotal: 42,
      accountType: "user",
    });
    expect((await rest("/sync/an-org", from("192.0.2.33"))).body).toMatchObject({
      state: "done",
      starredTotal: 0,
      accountType: "org",
      waiting: null,
    });
  });

  it("reports how many of a login's stars are read, and zeros for a login Stargrep does not know", async () => {
    expect((await rest("/sync/ada")).body).toMatchObject({
      state: "done",
      enrichment: { total: 1, read: 1, failed: 0, queued: 0 },
    });
    expect((await rest("/sync/nobody-known")).body).toMatchObject({
      state: "unknown",
      enrichment: { total: 0, read: 0, failed: 0, queued: 0 },
    });
  });

  it("rejects a login GitHub would not issue", async () => {
    expect((await rest("/sync/a..b", { method: "POST" })).status).toBe(400);
  });
});

describe("similarRepos", () => {
  it("answers over REST with the login in the query, and the same as the MCP tool", async () => {
    const { status, body } = await rest("/repos/42/similar?login=ada");
    expect(status).toBe(200);
    expect([body.inStars.map((found: { id: number }) => found.id), body.notStarred]).toEqual([[42], []]);
    const viaMcp = await tool("similarRepos", { id: 42, login: "ada" });
    expect(viaMcp.structuredContent).toEqual(body);
    expect((await rest("/repos/42/similar?login=nobody-synced")).body.code).toBe("ACCOUNT_NOT_SYNCED");
    expect((await rest("/repos/43/similar?login=ada")).body.code).toBe("REPO_NOT_FOUND");
  });
});

describe("people", () => {
  it("answers over REST with paging in the query, cacheable for anyone signed out, and the same as the MCP tool", async () => {
    const response = await call("/api/people?limit=1&sort=most-like-you");
    const body: Json = await response.json();
    expect([response.status, response.headers.get("cache-control"), response.headers.get("vary")]).toEqual([
      200,
      "public, max-age=300",
      "cookie",
    ]);
    expect(body).toEqual({
      sort: "recently-active",
      people: [
        {
          login: "theo",
          avatarUrl: null,
          curated: true,
          stars: 616,
          lastStarredAt: "2026-11-06T10:05:34.000Z",
          languages: [{ language: "TypeScript", share: 0.49 }],
          topics: ["react"],
          shared: null,
        },
      ],
      total: 1,
      nextOffset: null,
    });
    expect((await tool("people", { limit: 1 })).structuredContent).toEqual(body);
    expect((await rest("/people?limit=0")).status).toBe(400);
  });

  it("answers the people most like a login, and ACCOUNT_NOT_SYNCED for a login never synced", async () => {
    const { status, body } = await rest("/people/ada/similar");
    expect([
      status,
      body.people.map((found: { login: string; shared: number }) => [found.login, found.shared]),
    ]).toEqual([200, [["theo", 146]]]);
    expect((await tool("similarPeople", { login: "ada" })).structuredContent).toEqual(body);
    expect((await rest("/people/nobody-synced/similar")).body.code).toBe("ACCOUNT_NOT_SYNCED");
  });
});

describe("getRepo and the spec", () => {
  it("reads a repo by ID and says when there is none", async () => {
    expect((await rest("/repos/42")).body).toMatchObject({ id: 42, url: "https://github.com/ratatui/ratatui" });
    expect((await rest("/repos/43")).body.code).toBe("REPO_NOT_FOUND");
    expect((await rest("/repos/abc")).status).toBe(400);
  });

  it("puts a trace ID on the spec, and answers an unmatched path with each transport's error shape", async () => {
    const spec = await call("/openapi.json");
    expect([spec.status, spec.headers.get("x-trace-id")]).toEqual([200, traceId]);

    const unmatched = async (path: string, init?: RequestInit) => {
      const response = await call(path, init);
      const body: Json = await response.json();
      return { status: response.status, header: response.headers.get("x-trace-id"), body };
    };
    const viaRest = await unmatched("/api/no-such-route");
    expect(viaRest).toMatchObject({ status: 404, header: traceId, body: { code: "NOT_FOUND" } });
    expect(viaRest.body.data.traceId).toBe(viaRest.header);

    const viaRpc = await unmatched("/rpc/no-such-route", post({ json: {} }));
    expect(viaRpc).toMatchObject({ status: 404, header: traceId, body: { json: { code: "NOT_FOUND" } } });
    expect(viaRpc.body.json.data.traceId).toBe(viaRpc.header);

    const viaMcp = await unmatched("/mcp/no-such-route", post({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
    expect(viaMcp).toMatchObject({ status: 404, header: traceId, body: { id: 7, error: { code: -32000 } } });
    expect(viaMcp.body.error.data.traceId).toBe(viaMcp.header);
    expect(JSONRPCMessageSchema.safeParse(viaMcp.body).success).toBe(true);

    const withoutId = await unmatched("/mcp/no-such-route", { method: "POST", body: "not json" });
    expect(withoutId).toMatchObject({ status: 404, header: traceId, body: { error: { code: -32000 } } });
    expect("id" in withoutId.body).toBe(false);
    expect(JSONRPCMessageSchema.safeParse(withoutId.body).success).toBe(true);
  });

  it("lists every procedure in the OpenAPI document with only finite numbers", async () => {
    const response = await call("/openapi.json");
    const text = await response.text();
    expect(Object.keys(JSON.parse(text).paths).sort()).toEqual([
      "/config",
      "/facets",
      "/people",
      "/people/{login}/similar",
      "/repos/{id}",
      "/repos/{id}/similar",
      "/search",
      "/stars/{login}",
      "/sync/{login}",
    ]);
    expect(text).not.toMatch(/Infinity|NaN/);
    expect(JSON.parse(text).security).toEqual([]);
  });

  it("documents only the available search scope and the fields guaranteed by each sync state", async () => {
    const document: Json = await (await call("/openapi.json")).json();
    const search = document.paths["/search"].post.requestBody.content["application/json"].schema;
    expect(search.required).toEqual(["q", "scope"]);
    expect(search.properties.scope.properties.kind.enum).toEqual(["stars"]);
    expect(search.properties.scope.required).toEqual(["kind", "login"]);
    expect(search.properties.scope.properties.login.pattern).toBe(githubLogin.source);
    expect(JSON.stringify(document.paths["/search"].post.responses)).not.toMatch(
      /"(?:SIGN_IN_UNAVAILABLE|NOT_FOUND|REPO_NOT_FOUND|UNAUTHORIZED|SCOPE_UNAVAILABLE)"/,
    );
    expect(JSON.stringify(document.paths["/config"].get.responses)).not.toMatch(
      /"(?:SERVICE_UNAVAILABLE|TOO_MANY_REQUESTS|ACCOUNT_NOT_SYNCED)"/,
    );
    const status = document.paths["/sync/{login}"].get.responses["200"].content["application/json"].schema;
    expect(status.anyOf.map((variant: Json) => variant.properties.state.enum[0])).toEqual([
      "unknown",
      "waiting",
      "queued",
      "failed",
      "done",
    ]);
    expect(
      status.anyOf.find((variant: Json) => variant.properties.state.enum[0] === "done").properties.syncedAt.type,
    ).toBe("string");
    expect(
      status.anyOf.find((variant: Json) => variant.properties.state.enum[0] === "unknown").properties.syncedAt.type,
    ).toBe("null");
  });

  it("documents the stars cursor as the string a page's nextCursor gives, in and out", async () => {
    const document: Json = await (await call("/openapi.json")).json();
    const stars = document.paths["/stars/{login}"].get;
    const cursor = stars.parameters.find((parameter: Json) => parameter.name === "cursor");
    expect([cursor.required ?? false, cursor.schema.type]).toEqual([false, "string"]);
    const page = stars.responses["200"].content["application/json"].schema;
    expect(page.properties.nextCursor.anyOf.map((option: Json) => option.type)).toEqual(["string", "null"]);
  });

  it("answers a cursor it never issued with 400 and the issue, over REST", async () => {
    const refused = await rest("/stars/ada?cursor=1700000000000-0");
    expect([refused.status, refused.body.code, refused.body.data.traceId]).toEqual([400, "BAD_REQUEST", traceId]);
    expect(refused.body.data.issues[0].path).toEqual(["cursor", "repoId"]);
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
