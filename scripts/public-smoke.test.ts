import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import { type Answer, type Resends, untilRouted } from "./fresh-stage.ts";
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

test("public smoke on a new stage resends calls that met Cloudflare's Script not found page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resends: Resends = { scriptNotFound: 0, placement: 0, dropped: 0 };
      const seen = new Set<string>();
      const scriptNotFound: Answer = { status: 500, placement: undefined, body: "error code: 1104" };
      const worker = (path: string): Answer => ({
        status: 200,
        placement: "remote-IAD",
        body: path === "/health" ? '{"postgres":"17"}' : '{"state":"unknown"}',
      });
      const send = (request: HttpClientRequest.HttpClientRequest) => {
        const path = new URL(request.url).pathname;
        const answer = Effect.sync(() => {
          if (seen.has(path)) return worker(path);
          seen.add(path);
          return scriptNotFound;
        });
        return untilRouted(path, answer, resends);
      };
      const fiber = yield* Effect.forkChild(publicSmoke("https://stage.example", send));
      yield* TestClock.adjust("2 seconds");
      const checks = yield* Fiber.join(fiber);
      expect(checks.every(({ ok }) => ok)).toBe(true);
      expect(resends).toEqual({ scriptNotFound: 2, placement: 0, dropped: 0 });
    }).pipe(Effect.provide([TestClock.layer(), FetchHttpClient.layer])),
  ));
