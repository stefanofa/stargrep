import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Fake from "./github.fixture.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

describe("TokenGate.layerMemory", () => {
  effect("sends one token's requests one at a time", () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = Fake.make(() =>
      Effect.gen(function* () {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        yield* Effect.sleep("100 millis");
        inFlight--;
        return { headers: Fake.rateLimitHeaders(4000) };
      }),
    );
    const layer = TokenGate.layerMemory({ token: Redacted.make(Fake.token), share: 1 as BudgetShare }).pipe(
      Layer.provide(fake.client),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const fiber = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, () => gate.execute(HttpClientRequest.get("https://api.github.com/rate_limit"))),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toHaveLength(20);
      expect(maxInFlight).toBe(1);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual(Array.from({ length: 20 }, (_, i) => i * 100));
    }).pipe(Effect.provide(layer));
  });
});
