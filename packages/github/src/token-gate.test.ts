import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Fake from "./github.fixture.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

describe("TokenGate.layerMemory", () => {
  effect("keeps one exchange per token in flight, from send until its body is read", () => {
    let sent = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        sent++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const body = new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
              inFlight--;
            },
          },
          { highWaterMark: 0 },
        );
        return HttpClientResponse.fromWeb(request, new Response(body, { headers: Fake.rateLimitHeaders(4000) }));
      }),
    );
    const layer = TokenGate.layerMemory({ token: Redacted.make(Fake.token), share: 1 as BudgetShare }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const replies = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          gate.execute("list-stars", HttpClientRequest.get("https://api.github.com/rate_limit")),
        ),
        { concurrency: "unbounded" },
      );
      expect(replies.map((reply) => reply.body)).toEqual(Array.from({ length: 20 }, () => Option.some("ok")));
      expect(sent).toBe(20);
      expect(maxInFlight).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
