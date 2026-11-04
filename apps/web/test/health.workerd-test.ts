import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://web${path}`, init));

describe("health forwarding", () => {
  it.each([
    ["GET", "/health"],
    ["GET", "/health?x=1"],
    ["POST", "/health"],
  ])("passes %s %s to the main Worker unchanged", async (method, path) => {
    const response = await call(path, { method, headers: { "x-probe": "kept" } });
    expect(response.headers.get("x-answered-by")).toBe("main");
    expect(await response.json()).toEqual({ method, url: `http://web${path}`, probe: "kept" });
  });

  it.each(["/health/", "/healthz"])("keeps %s on the web Worker", async (path) => {
    const response = await call(path);
    expect({ status: response.status, answeredBy: response.headers.get("x-answered-by") }).toEqual({
      status: 404,
      answeredBy: null,
    });
  });

  it("leaves the web Worker's own routes on the web Worker", async () => {
    const answers = await Promise.all(
      ["/openapi.json", "/api/sync/ada", "/api/health", "/rpc/health", "/mcp/health"].map(async (path) => {
        const response = await call(path);
        return {
          path,
          status: response.status,
          answeredBy: response.headers.get("x-answered-by"),
          traced: response.headers.has("x-trace-id"),
        };
      }),
    );
    expect(answers).toEqual([
      { path: "/openapi.json", status: 200, answeredBy: null, traced: true },
      { path: "/api/sync/ada", status: 200, answeredBy: null, traced: true },
      { path: "/api/health", status: 404, answeredBy: null, traced: true },
      { path: "/rpc/health", status: 404, answeredBy: null, traced: true },
      { path: "/mcp/health", status: 404, answeredBy: null, traced: true },
    ]);
  });
});
