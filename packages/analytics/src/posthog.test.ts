import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Brand from "effect/Brand";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Analytics from "./analytics.ts";
import * as PostHog from "./posthog.ts";
import * as Project from "./project.ts";

const caller = Brand.nominal<string & Brand.Brand<"CallerKey">>()("0123456789abcdef0123456789abcdef");
const userId = Brand.nominal<string & Brand.Brand<"UserId">>()("user-1");

interface Sent {
  readonly url: string;
  readonly body: {
    readonly api_key: string;
    readonly batch: ReadonlyArray<{ readonly event: string; readonly properties: Record<string, unknown> }>;
  };
}

// A PostHog that records each request, or answers every one with the given status.
const postHog = (status = 200) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag === "Uint8Array") {
        sent.push({ url: request.url, body: JSON.parse(new TextDecoder().decode(request.body.body)) });
      }
      return HttpClientResponse.fromWeb(request, new Response("{}", { status }));
    }),
  );
  return { sent, client: Layer.succeed(HttpClient.HttpClient, client) };
};

const down = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
      }),
    ),
  ),
);

// Runs each send in place, so a test sees it finish before the scope's close returns.
const sends: Array<Effect.Effect<void>> = [];
const inPlace = (send: Effect.Effect<void>) =>
  Effect.sync(() => {
    sends.push(send);
  }).pipe(Effect.andThen(send));

const layerFor = (client: Layer.Layer<HttpClient.HttpClient>) =>
  PostHog.layer({ stage: "prod", background: inPlace }).pipe(
    Layer.provide(client),
    Layer.provide(Digest.layerWebCrypto),
  );

const searched = Analytics.Event.Search({
  planSource: "model",
  results: 12,
  latencyMillis: 840,
  answerCache: "miss",
  transport: "rpc",
});

describe("PostHog", () => {
  it.effect("sends every event of a scope in one batch when the scope closes, each with its stage", () => {
    const { sent, client } = postHog();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Analytics.capture(searched).pipe(Analytics.withActor(Analytics.Actor.Network({ caller })));
          yield* Analytics.capture(Analytics.Event.SignedUp()).pipe(
            Analytics.withActor(Analytics.Actor.User({ userId })),
          );
          yield* Analytics.capture(Analytics.Event.SummaryGenerated({ model: "anthropic/claude-haiku-5.5" }));
          expect(sent).toEqual([]);
        }).pipe(Effect.provide(layerFor(client))),
      );
      expect(sent.map(({ url }) => url)).toEqual([`${Project.captureHost}/batch/`]);
      const [request] = sent;
      expect(request?.body.api_key).toBe(Project.projectToken);
      expect(request?.body.batch.map(({ event }) => event)).toEqual(["search", "signed_up", "summary_generated"]);
      expect(request?.body.batch.map(({ properties }) => properties.stage)).toEqual(["prod", "prod", "prod"]);
    });
  });

  it.effect("names a network by a hash of its caller key and a user by their ID", () => {
    const { sent, client } = postHog();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Analytics.capture(searched).pipe(Analytics.withActor(Analytics.Actor.Network({ caller })));
          yield* Analytics.capture(searched).pipe(Analytics.withActor(Analytics.Actor.User({ userId })));
          yield* Analytics.capture(searched);
        }).pipe(Effect.provide(layerFor(client))),
      );
      const [network, user, stargrep] = sent[0]?.body.batch ?? [];
      expect(network?.properties.distinct_id).toMatch(/^[0-9a-f]{32}$/);
      expect(network?.properties.distinct_id).not.toBe(caller);
      expect(network?.properties.$process_person_profile).toBe(false);
      expect(user?.properties.distinct_id).toBe(userId);
      expect(user?.properties).not.toHaveProperty("$process_person_profile");
      expect(stargrep?.properties.distinct_id).toBe("stargrep");
    });
  });

  it.effect("sends nothing for a scope that captured nothing", () => {
    const { sent, client } = postHog();
    return Effect.gen(function* () {
      yield* Effect.scoped(Effect.provide(Effect.void, layerFor(client)));
      expect(sent).toEqual([]);
    });
  });

  it.effect("drops the events and fails nothing when PostHog is down or refuses them", () =>
    Effect.gen(function* () {
      for (const client of [down, postHog(503).client]) {
        const answer = yield* Effect.scoped(
          Analytics.capture(searched).pipe(Effect.as("answered"), Effect.provide(layerFor(client))),
        );
        expect(answer).toBe("answered");
        expect(yield* Effect.exit(sends.at(-1) ?? Effect.die("no send"))).toEqual(yield* Effect.exit(Effect.void));
      }
    }),
  );

  it.effect("fails nothing when the send cannot start", () => {
    const { client } = postHog();
    const broken = PostHog.layer({ stage: "prod", background: () => Effect.die("no waitUntil here") }).pipe(
      Layer.provide(client),
      Layer.provide(Digest.layerWebCrypto),
    );
    return Effect.gen(function* () {
      const answer = yield* Effect.scoped(
        Analytics.capture(searched).pipe(Effect.as("answered"), Effect.provide(broken)),
      );
      expect(answer).toBe("answered");
    });
  });

  it.effect("sends a model call's tokens, latency, and cost under PostHog's AI names", () => {
    const { sent, client } = postHog();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Analytics.capture(
          Analytics.Event.ModelCall({
            operation: "generate",
            purpose: "plan",
            provider: "gateway",
            model: "anthropic/claude-haiku-5.5",
            latencyMillis: 1250,
            inputTokens: 900,
            outputTokens: 120,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
            costUsd: 0.0021,
            error: undefined,
            traceId: "trace-1",
          }),
        ).pipe(Effect.provide(layerFor(client))),
      );
      expect(sent[0]?.body.batch[0]).toMatchObject({
        event: "$ai_generation",
        properties: {
          $ai_provider: "anthropic",
          $ai_model: "claude-haiku-5.5",
          $ai_span_name: "plan",
          $ai_trace_id: "trace-1",
          $ai_latency: 1.25,
          $ai_input_tokens: 900,
          $ai_output_tokens: 120,
          $ai_total_cost_usd: 0.0021,
          $ai_cost_passthrough: true,
          $ai_is_error: false,
          stage: "prod",
        },
      });
      expect(Object.keys(sent[0]?.body.batch[0]?.properties ?? {})).not.toContain("$ai_input");
    });
  });

  test("lists an exception's frames oldest first", () => {
    const encoded = PostHog.encode("prod", "stargrep", {
      actor: Analytics.Actor.Stargrep(),
      at: 0,
      event: Analytics.Event.Exception({
        source: "Queue batch failed",
        traceId: undefined,
        thrown: [
          {
            type: "TypeError",
            value: "x is undefined",
            stack:
              "TypeError: x is undefined\n    at settle (worker.js:10:5)\n    at worker.js:20:7\n    at Consumer.processBatch",
          },
        ],
      }),
    });
    expect(encoded.event).toBe("$exception");
    expect(encoded.properties).toMatchObject({
      source: "Queue batch failed",
      $exception_list: [
        {
          type: "TypeError",
          value: "x is undefined",
          mechanism: { handled: false, synthetic: false },
          stacktrace: {
            type: "raw",
            frames: [
              { function: "Consumer.processBatch", platform: "custom", lang: "javascript" },
              { function: "?", filename: "worker.js", lineno: 20, colno: 7 },
              { function: "settle", filename: "worker.js", lineno: 10, colno: 5 },
            ],
          },
        },
      ],
    });
  });
});
