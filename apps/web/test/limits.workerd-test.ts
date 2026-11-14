import { env } from "cloudflare:workers";
import { RateLimiter, type RateLimitKind } from "@stargrep/api/rate-limiter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { rateLimitPolicy } from "../rate-limit-policy.ts";
import { layerCaller } from "../src/server/caller.ts";
import { layerRateLimiter, type RateLimitBindings } from "../src/server/rate-limiter.ts";
import { layerFor } from "./entry.ts";
import { testServer } from "./serve.ts";

// Bindings with each policy's limit that count every key with no window, so a test never depends on the minute it
// runs in. The real bindings count in windows of the wall clock's minute.
const windowless = (): RateLimitBindings =>
  Record.map(rateLimitPolicy, ({ simple }): RateLimit => {
    const counts = new Map<string, number>();
    return {
      limit: async ({ key }) => {
        const count = counts.get(key) ?? 0;
        if (count >= simple.limit) return { success: false };
        counts.set(key, count + 1);
        return { success: true };
      },
    };
  });

const acquire = (kind: RateLimitKind, ip: string, bindings: RateLimitBindings) =>
  Effect.runPromise(
    RateLimiter.use((limiter) => limiter.acquire(kind)).pipe(
      Effect.match({ onFailure: (refused) => refused, onSuccess: () => "allowed" as const }),
      Effect.provide(
        layerRateLimiter(bindings).pipe(
          Layer.provide(
            layerCaller(env.CALLER_KEY, new Request("https://stargrep.test/", { headers: { "cf-connecting-ip": ip } })),
          ),
        ),
      ),
    ),
  );

describe("the rate limiter on Workers rate limiting", () => {
  it("counts syncs from one IPv6 network by its /64, however the caller rotates its address", async () => {
    const bindings = windowless();
    const answers = [];
    for (let host = 1; host <= 6; host++) answers.push(await acquire("sync", `2001:db8:5:6::${host}`, bindings));
    expect(answers.slice(0, 5)).toEqual(Array(5).fill("allowed"));
    expect(answers[5]).toMatchObject({ _tag: "RateLimited", limit: "network" });
    expect(await acquire("sync", "2001:db8:5:7::1", bindings)).toBe("allowed");
  });

  it("counts an IPv4-mapped IPv6 caller with its IPv4 address", async () => {
    const bindings = windowless();
    for (let attempt = 0; attempt < 60; attempt++) {
      expect(await acquire("stars", "192.0.2.80", bindings)).toBe("allowed");
    }
    expect(await acquire("stars", "::ffff:192.0.2.80", bindings)).toMatchObject({
      _tag: "RateLimited",
      limit: "network",
    });
    expect(await acquire("stars", "::ffff:192.0.2.81", bindings)).toBe("allowed");
  });

  it("keeps each kind's own count", async () => {
    const bindings = windowless();
    for (let attempt = 0; attempt < 60; attempt++) await acquire("stars", "192.0.2.82", bindings);
    expect(await acquire("stars", "192.0.2.82", bindings)).toMatchObject({ _tag: "RateLimited" });
    expect(await acquire("search", "192.0.2.82", bindings)).toBe("allowed");
  });

  it("fails as unavailable when the binding cannot answer", async () => {
    const down = { limit: () => Promise.reject(new Error("limiter down")) } as unknown as RateLimit;
    expect(await acquire("search", "192.0.2.83", { ...env, SEARCH_PER_CALLER: down })).toMatchObject({
      _tag: "RateLimiterUnavailable",
    });
  });
});

describe("the stars limit", () => {
  // The binding counts in windows of the wall clock's minute, so 61 pages can straddle two of them. Every request here
  // reads a test clock that stands still, so all 61 land in one instant of the network's line, which refuses the last.
  const serve = testServer((request) => layerFor(request).pipe(Layer.provideMerge(TestClock.layer())));

  it("answers the 61st page of stars in a minute from one network with 429, and still answers another network", async () => {
    const stars = async (ip: string) => {
      const answered = await serve(new Request("http://web/api/stars/ada", { headers: { "cf-connecting-ip": ip } }));
      if (answered === undefined) throw new Error("no route answered /api/stars/ada");
      return answered;
    };
    const statuses: Array<number> = [];
    for (let attempt = 0; attempt < 61; attempt++) statuses.push((await stars("192.0.2.90")).status);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    const refused = await stars("192.0.2.90");
    const body: { readonly code: string } = await refused.json();
    expect([statuses[60], refused.status, body.code]).toEqual([429, 429, "TOO_MANY_REQUESTS"]);
    expect((await stars("192.0.2.91")).status).toBe(200);
  });
});
