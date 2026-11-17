import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as BulkGate from "./bulk-gate.ts";
import * as Fake from "./github.fixture.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

const page = HttpClientRequest.get("https://api.github.com/users/octocat/starred");

const gateOn = (client: HttpClient.HttpClient, readers: number, share = 1 as BudgetShare) =>
  BulkGate.layer({ token: Redacted.make(Fake.token), share, readers }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

// A client whose replies wait for release, counting the requests GitHub holds at once.
const holding = (release: Deferred.Deferred<void>, reply: (index: number) => Response) => {
  const seen = { sent: 0, inFlight: 0, maxInFlight: 0 };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const index = seen.sent++;
      seen.maxInFlight = Math.max(seen.maxInFlight, ++seen.inFlight);
      if (index > 0) yield* Deferred.await(release);
      seen.inFlight--;
      return HttpClientResponse.fromWeb(request, reply(index));
    }),
  );
  return { seen, client };
};

const settled = (count: number) => Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow);

describe("BulkGate", () => {
  effect("keeps at most its readers' requests in flight", () => {
    const release = Deferred.makeUnsafe<void>();
    const { seen, client } = holding(release, () => new Response("ok", { headers: Fake.rateLimitHeaders(4000) }));
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      yield* gate.execute("list-stars", page);
      const all = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 10 }, () => gate.execute("list-stars", page)),
          { concurrency: "unbounded" },
        ),
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => seen.inFlight === 3 }));
      yield* settled(50);
      expect(seen.inFlight).toBe(3);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(all)).toHaveLength(10);
      expect([seen.sent, seen.maxInFlight]).toEqual([11, 3]);
    }).pipe(Effect.provide(gateOn(client, 3)));
  });

  effect("spends no more than its share of a window's limit, and sends the rest once the window resets", () => {
    const windowSeconds = 600;
    const github = { remaining: 100, resetAt: windowSeconds, sentBy: new Map<number, number>() };
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now >= github.resetAt * 1000) {
          github.remaining = 100;
          github.resetAt += windowSeconds;
        }
        github.remaining--;
        github.sentBy.set(github.resetAt, (github.sentBy.get(github.resetAt) ?? 0) + 1);
        return HttpClientResponse.fromWeb(
          request,
          new Response("[]", {
            headers: {
              "x-ratelimit-resource": "core",
              "x-ratelimit-limit": "100",
              "x-ratelimit-remaining": String(github.remaining),
              "x-ratelimit-reset": String(github.resetAt),
            },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const all = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 40 }, () => gate.execute("list-stars", page)),
          { concurrency: "unbounded" },
        ),
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => github.sentBy.get(windowSeconds) === 30 }));
      yield* settled(50);
      expect(github.sentBy.get(windowSeconds)).toBe(30);
      expect(github.remaining).toBe(70);

      yield* TestClock.adjust(windowSeconds * 1000 + BulkGate.resetMargin);
      expect(yield* Fiber.join(all)).toHaveLength(40);
      expect([...github.sentBy]).toEqual([
        [windowSeconds, 30],
        [2 * windowSeconds, 10],
      ]);
    }).pipe(Effect.provide(gateOn(client, 3, 0.3 as BudgetShare)));
  });

  effect("holds every request for the wait a secondary rate limit names, then sends with one reader fewer", () => {
    const release = Deferred.makeUnsafe<void>();
    const { seen, client } = holding(release, (index) =>
      index === 0
        ? new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
            status: 403,
            headers: { ...Fake.rateLimitHeaders(4000), "retry-after": "30" },
          })
        : new Response("[]", { headers: Fake.rateLimitHeaders(3999) }),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      expect((yield* gate.execute("list-stars", page)).status).toBe(403);
      const all = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 6 }, () =>
            gate.execute("owner", HttpClientRequest.post("https://api.github.com/graphql")),
          ),
          { concurrency: "unbounded" },
        ),
      );
      yield* settled(50);
      expect(seen.sent).toBe(1);

      yield* TestClock.adjust("29 seconds");
      expect(seen.sent).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => seen.inFlight === 2 }));
      yield* settled(50);
      expect(seen.inFlight).toBe(2);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(all)).toHaveLength(6);
      expect([seen.sent, seen.maxInFlight]).toEqual([7, 2]);
    }).pipe(Effect.provide(gateOn(client, 3)));
  });
});
