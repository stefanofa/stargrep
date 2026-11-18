import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { Actor, Analytics, type Captured, Event, type Thrown } from "./analytics.ts";
import { captureHost, projectToken } from "./project.ts";

// A Worker invocation that captures more than this, such as a runaway loop, drops the rest instead of growing.
const maxEvents = 1_000;
const sendTimeout = Duration.seconds(10);

type Properties = Readonly<Record<string, unknown>>;

const defined = (properties: Record<string, unknown>): Properties =>
  Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));

// A Gateway model ID names its vendor first, such as anthropic/claude-haiku-5.5. PostHog prices a call by vendor and
// model when the provider reported no cost.
const vendorModel = (provider: string, model: string) => {
  const slash = model.indexOf("/");
  return slash < 0
    ? { $ai_provider: provider, $ai_model: model }
    : { $ai_provider: model.slice(0, slash), $ai_model: model.slice(slash + 1) };
};

const v8Frame = /^\s*at (?:(.+?) )?\(?([^()\s]+):(\d+):(\d+)\)?$/;
const namedFrame = /^\s*at (.+)$/;

// PostHog reads frames oldest first, the reverse of a V8 stack.
const framesOf = (stack: string | undefined) =>
  (stack ?? "")
    .split("\n")
    .flatMap((line) => {
      const located = v8Frame.exec(line);
      if (located !== null) {
        const [, fn, filename, lineno, colno] = located;
        return [{ function: fn ?? "?", filename, lineno: Number(lineno), colno: Number(colno) }];
      }
      const named = namedFrame.exec(line);
      return named === null ? [] : [{ function: named[1] }];
    })
    .map((frame) => ({ platform: "custom", lang: "javascript", in_app: true, ...frame }))
    .reverse();

const wireException = (thrown: Thrown) => {
  const frames = framesOf(thrown.stack);
  return {
    type: thrown.type,
    value: thrown.value,
    mechanism: { handled: false, synthetic: frames.length === 0 },
    ...(frames.length === 0 ? {} : { stacktrace: { type: "raw", frames } }),
  };
};

const wireOf = Event.$match({
  SignedUp: () => ({ event: "signed_up", properties: {} }),
  // The person property counts the waitlist as it stands, so an opt-out leaves it.
  MonthlyPicksOptedIn: () => ({ event: "monthly_picks_opted_in", properties: { $set: { monthly_picks: true } } }),
  MonthlyPicksOptedOut: () => ({ event: "monthly_picks_opted_out", properties: { $set: { monthly_picks: false } } }),
  StarsImportStarted: (event) => ({
    event: "stars_import_started",
    properties: {
      stars: event.stars,
      signed_in: event.signedIn,
      mode: event.mode,
      first_import: event.first,
      wait_seconds: event.waitSeconds,
    },
  }),
  StarsImportFinished: (event) => ({
    event: "stars_import_finished",
    properties: {
      stars: event.listed,
      added: event.added,
      enqueued: event.enqueued,
      signed_in: event.signedIn,
      mode: event.mode,
      duration_seconds: event.durationMillis / 1000,
      since_request_seconds: event.sinceRequestMillis === null ? null : event.sinceRequestMillis / 1000,
    },
  }),
  Search: (event) => ({
    event: "search",
    properties: {
      plan_source: event.planSource,
      results: event.results,
      latency_ms: event.latencyMillis,
      answer_cache: event.answerCache,
      cache_hit: event.answerCache === "hit" || event.answerCache === "stale",
      transport: event.transport,
    },
  }),
  SummaryGenerated: (event) => ({ event: "summary_generated", properties: { model: event.model } }),
  ModelCall: (event) => ({
    event: event.operation === "generate" ? "$ai_generation" : "$ai_embedding",
    properties: defined({
      ...vendorModel(event.provider, event.model),
      $ai_trace_id: event.traceId,
      $ai_span_name: event.purpose,
      $ai_latency: event.latencyMillis / 1000,
      $ai_input_tokens: event.inputTokens,
      $ai_output_tokens: event.operation === "generate" ? event.outputTokens : undefined,
      $ai_cache_read_input_tokens: event.cacheReadTokens,
      $ai_cache_creation_input_tokens: event.cacheWriteTokens,
      $ai_total_cost_usd: event.costUsd,
      $ai_cost_passthrough: event.costUsd === undefined ? undefined : true,
      $ai_is_error: event.error !== undefined,
      $ai_error: event.error,
      $ai_stream: false,
    }),
  }),
  Exception: (event) => ({
    event: "$exception",
    properties: defined({
      $exception_list: event.thrown.map(wireException),
      source: event.source,
      trace_id: event.traceId,
      queue: event.queue,
      error_tag: event.error,
    }),
  }),
});

// A visitor without an account is only their network, so PostHog keeps no person profile for them, or for Stargrep.
export const encode = (stage: string, distinctId: string, { actor, event, at }: Captured) => {
  const wire = wireOf(event);
  return {
    event: wire.event,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(at)),
    properties: {
      ...wire.properties,
      distinct_id: distinctId,
      stage,
      ...(actor._tag === "User" ? {} : { $process_person_profile: false }),
    },
  };
};

const utf8 = new TextEncoder();

// A caller key never reaches PostHog. Its hash names the network there and matches no row in Postgres.
const distinctIdOf = (digest: Digest.Digest["Service"]) =>
  Actor.$match({
    User: ({ userId }) => Effect.succeed<string>(userId),
    Network: ({ caller }) =>
      digest.digestHex(Digest.sha256, utf8.encode(`posthog/${caller}`)).pipe(Effect.map((hex) => hex.slice(0, 32))),
    Stargrep: () => Effect.succeed("stargrep"),
  });

export interface Options<R> {
  readonly stage: string;
  // Runs the send after the response, as waitUntil does, so no request waits on PostHog.
  readonly background: (send: Effect.Effect<void>) => Effect.Effect<void, never, R>;
}

// Events wait in memory until the layer's scope closes, then go out in one request. A Worker invocation holds at most
// six connections, so one request per invocation leaves the rest to the database and the queues. A failed send is
// logged and its events are dropped.
export const layer = <R>(options: Options<R>) =>
  Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const distinctId = distinctIdOf(yield* Digest.Digest);
      const pending: Array<Captured> = [];
      const send = (batch: ReadonlyArray<Captured>) =>
        Effect.forEach(batch, (captured) =>
          Effect.map(distinctId(captured.actor), (id) => encode(options.stage, id, captured)),
        ).pipe(
          Effect.flatMap((events) =>
            client.execute(
              HttpClientRequest.post(`${captureHost}/batch/`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ api_key: projectToken, batch: events }),
              ),
            ),
          ),
          Effect.timeout(sendTimeout),
          Effect.catchCause(() =>
            Effect.logWarning("PostHog capture failed, so its events were dropped", { events: batch.length }),
          ),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.asVoid,
        );
      // A send that cannot even start, such as one with no waitUntil to run under, drops its events too.
      const flush = (batch: ReadonlyArray<Captured>) =>
        options.background(send(batch)).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("PostHog capture could not start, so its events were dropped", {
              events: batch.length,
            }),
          ),
        );
      yield* Effect.addFinalizer(() => (pending.length === 0 ? Effect.void : flush(pending.splice(0))));
      return Analytics.of({
        capture: (captured) => {
          if (pending.length < maxEvents) pending.push(captured);
        },
      });
    }),
  );
