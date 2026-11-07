import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { publicSmoke } from "./public-smoke.ts";

test("public smoke uses only health and a read-only database API", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  await using server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path });
      return Response.json(path === "/health" ? { postgres: "17" } : { state: "unknown" });
    },
  });
  const checks = await Effect.runPromise(publicSmoke(server.url.href).pipe(Effect.provide(FetchHttpClient.layer)));
  expect(checks.every(({ ok }) => ok)).toBe(true);
  expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  expect(requests[0]?.path).toBe("/health");
  expect(requests[1]?.path).toMatch(/^\/api\/sync\/smoke-\d+$/);
});

test("public smoke fails when health is unavailable", async () => {
  await using server = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/health"
        ? new Response("unavailable", { status: 503 })
        : Response.json({ state: "unknown" });
    },
  });
  const checks = await Effect.runPromise(publicSmoke(server.url.href).pipe(Effect.provide(FetchHttpClient.layer)));
  expect(checks.every(({ ok }) => ok)).toBe(false);
});
