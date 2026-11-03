import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Fake from "./github.fixture.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

describe("TokenGate.layerMemory", () => {
  effect("keeps one exchange in flight per token, from send until the body is read", () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = Fake.make(() => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      return { headers: Fake.rateLimitHeaders(4000) };
    });
    const layer = TokenGate.layerMemory({ token: Redacted.make(Fake.token), share: 1 as BudgetShare }).pipe(
      Layer.provide(fake.client),
    );
    const readSlowly = (response: HttpClientResponse.HttpClientResponse) =>
      Effect.sleep("100 millis").pipe(Effect.as(response.status), Effect.ensuring(Effect.sync(() => inFlight--)));
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const fiber = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, () =>
            gate.execute(HttpClientRequest.get("https://api.github.com/rate_limit"), readSlowly),
          ),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(Array.from({ length: 20 }, () => 200));
      expect(maxInFlight).toBe(1);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual(Array.from({ length: 20 }, (_, i) => i * 100));
    }).pipe(Effect.provide(layer));
  });

  effect("aborts an exchange whose body the reader leaves unread", () => {
    const fake = Fake.make(() => ({ status: 404, body: "not read", headers: Fake.rateLimitHeaders(4000) }));
    const layer = TokenGate.layerMemory({ token: Redacted.make(Fake.token), share: 1 as BudgetShare }).pipe(
      Layer.provide(fake.client),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const status = yield* gate.execute(HttpClientRequest.get("https://api.github.com/missing"), (response) =>
        Effect.succeed(response.status),
      );
      expect(status).toBe(404);
      expect(fake.sent[0]?.signal.aborted).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
