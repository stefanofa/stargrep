import { middlewareGen } from "@orpc/effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface StoredAnswer {
  readonly storedAt: number;
  readonly body: string;
}

// Where answers are kept. A read that fails is a miss, and a write that fails is dropped, so the cache can only make an
// answer faster, never fail it.
export interface AnswerCache {
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredAnswer>>;
  readonly set: (key: string, body: string, keepFor: Duration.Duration) => Effect.Effect<void>;
}

export const disabled: AnswerCache = {
  get: () => Effect.succeedNone,
  set: () => Effect.void,
};

export const memory = () => {
  const entries = new Map<string, StoredAnswer & { readonly expiresAt: number }>();
  const cache: AnswerCache = {
    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        Option.filter(Option.fromUndefinedOr(entries.get(key)), (entry) => entry.expiresAt > now),
      ),
    set: (key, body, keepFor) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        entries.set(key, { storedAt: now, body, expiresAt: now + Duration.toMillis(keepFor) });
      }),
  };
  return { cache, entries };
};

// What a cached procedure needs from its request.
export interface AnswerContext {
  readonly answerCache: AnswerCache;
  readonly execution: "request" | "refresh";
  readonly background: (run: Effect.Effect<void>) => Effect.Effect<void>;
  // oRPC's ResponseHeadersHandlerPlugin sets this on the HTTP transports.
  readonly resHeaders?: Headers | undefined;
}

export interface AnswerPolicy<A> {
  readonly procedure: "search" | "stars";
  readonly json: Schema.Codec<A, string>;
  // How long a stored answer is served as is.
  readonly fresh: Duration.Duration;
  // How long after that it is still served while a refresh runs.
  readonly stale: Duration.Duration;
  readonly keep: (answer: A) => boolean;
}

const answersServed = Metric.counter("stargrep_answer_cache", {
  description: "Answers of cached procedures, by procedure and whether the cache served them fresh, stale, or not.",
});

const served = (
  context: AnswerContext,
  procedure: AnswerPolicy<unknown>["procedure"],
  outcome: "hit" | "stale" | "miss",
) =>
  Effect.andThen(
    Effect.sync(() => context.resHeaders?.set("x-answer-cache", outcome)),
    Metric.update(Metric.withAttributes(answersServed, { procedure, outcome }), 1),
  );

// When each key's latest refresh in this isolate started, oldest first. A refresh that stores its answer frees its key.
// One that stores nothing, such as an answer the planner could not plan, keeps it, so a stale answer starts at most one
// refresh per fresh window however its refreshes end.
export const claimRefresh = (
  refreshStarts: Map<string, number>,
  key: string,
  now: number,
  every: Duration.Duration,
) => {
  for (const [started, at] of refreshStarts) {
    if (now - at < Duration.toMillis(every)) break;
    refreshStarts.delete(started);
  }
  if (refreshStarts.has(key)) return false;
  refreshStarts.set(key, now);
  return true;
};

export const answerCache = <I, A, C extends AnswerContext>(
  policy: AnswerPolicy<A>,
  keyOf: (input: I, context: C) => Option.Option<string>,
) => {
  const refreshStarts = new Map<string, number>();
  // Refreshes outlive the request signal. middlewareGen still joins the background fiber's interruption signal.
  const refreshSignal = new AbortController().signal;
  const decode = Schema.decodeEffect(policy.json);
  const encode = Schema.encodeEffect(policy.json);
  const keepFor = Duration.sum(policy.fresh, policy.stale);
  const refreshContext = { execution: "refresh", resHeaders: undefined } satisfies Pick<
    AnswerContext,
    "execution" | "resHeaders"
  >;
  return middlewareGen<C, object, I, A>(function* ({ context, next }, input, done) {
    const keyOption = keyOf(input, context);
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    if (Option.isNone(keyOption)) return yield* next();
    const key = keyOption.value;
    const store = (answer: A) =>
      encode(answer).pipe(
        Effect.flatMap((body) => context.answerCache.set(key, body, keepFor)),
        Effect.catchTags({
          SchemaError: () => Effect.logWarning("Answer does not encode", { procedure: policy.procedure }),
        }),
      );

    const stored = yield* context.answerCache.get(key);
    if (Option.isSome(stored)) {
      const now = yield* Clock.currentTimeMillis;
      const answer = yield* Effect.option(decode(stored.value.body));
      const age = Duration.millis(Math.max(0, now - stored.value.storedAt));
      if (Option.isSome(answer) && Duration.isLessThan(age, keepFor)) {
        if (Duration.isLessThan(age, policy.fresh)) {
          yield* served(context, policy.procedure, "hit");
          return done({ output: answer.value });
        }
        if (claimRefresh(refreshStarts, key, now, policy.fresh)) {
          yield* context.background(
            Effect.gen(function* () {
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
              const fresh = yield* next({
                context: refreshContext,
                signal: refreshSignal,
              });
              return fresh.output;
            }).pipe(
              Effect.flatMap((fresh) =>
                policy.keep(fresh)
                  ? Effect.andThen(
                      store(fresh),
                      Effect.sync(() => refreshStarts.delete(key)),
                    )
                  : Effect.void,
              ),
              Effect.catch((error) =>
                Effect.logWarning("Answer refresh failed", {
                  procedure: policy.procedure,
                  error: error instanceof Error ? error.name : typeof error,
                }),
              ),
            ),
          );
        }
        yield* served(context, policy.procedure, "stale");
        return done({ output: answer.value });
      }
    }
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    const result = yield* next();
    if (policy.keep(result.output)) yield* store(result.output);
    yield* served(context, policy.procedure, "miss");
    return result;
  });
};
