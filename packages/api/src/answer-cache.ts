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

// Where answers are kept. A read that fails is a miss, and a write or delete that fails is dropped, so the cache can
// only make an answer faster, never fail it.
export interface AnswerCache {
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredAnswer>>;
  readonly set: (key: string, body: string, keepFor: Duration.Duration) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
}

export const disabled: AnswerCache = {
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  delete: () => Effect.void,
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
    delete: (key) =>
      Effect.sync(() => {
        entries.delete(key);
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

// How long a demo search answer is served as is, and how long after that while a refresh runs. A page built from one
// keeps the same windows, measured from when the answer was stored.
export const searchWindows = { fresh: Duration.minutes(5), stale: Duration.days(1) } as const;

export interface AnswerPolicy<A> {
  readonly procedure: "search" | "stars" | "similarRepos" | "similarPeople";
  readonly json: Schema.Codec<A, string>;
  // How long a stored answer is served as is.
  readonly fresh: Duration.Duration;
  // How long after that it is still served while a refresh runs.
  readonly stale: Duration.Duration;
  readonly keep: (answer: A) => boolean;
  // A refresh that fails this way means the request has no answer any more, such as a filter by a subject curation has
  // since rejected, so the stale answer is deleted instead of served for the rest of its stale window.
  readonly refused: (error: unknown) => boolean;
}

const answersServed = Metric.counter("stargrep_answer_cache", {
  description: "Answers of cached procedures, by procedure and whether the cache served them fresh, stale, or not.",
});

// x-answer-stored-at says when the answer was computed, so a caller that keeps something built from it can expire it
// with the answer instead of from the moment it read it.
const served = (
  context: AnswerContext,
  procedure: AnswerPolicy<unknown>["procedure"],
  outcome: "hit" | "stale" | "miss",
  storedAt: number,
) =>
  Effect.andThen(
    Effect.sync(() => {
      context.resHeaders?.set("x-answer-cache", outcome);
      context.resHeaders?.set("x-answer-stored-at", String(storedAt));
    }),
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

// What the cache would serve for a key. A hit is fresh enough to serve as is, a stale answer is past that but inside its
// stale window, and a miss is nothing to serve. A read never computes or refreshes an answer.
export type Cached<A> =
  | { readonly outcome: "hit" | "stale"; readonly answer: A; readonly storedAt: number }
  | { readonly outcome: "miss" };

export const miss: Cached<never> = { outcome: "miss" };

export const reader = <A>(policy: Pick<AnswerPolicy<A>, "json" | "fresh" | "stale">) => {
  const decode = Schema.decodeEffect(policy.json);
  const keepFor = Duration.sum(policy.fresh, policy.stale);
  return Effect.fnUntraced(function* (cache: AnswerCache, key: string) {
    const stored = yield* cache.get(key);
    if (Option.isNone(stored)) return miss;
    const age = Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - stored.value.storedAt));
    const answer = yield* Effect.option(decode(stored.value.body));
    if (Option.isNone(answer) || !Duration.isLessThan(age, keepFor)) return miss;
    const outcome = Duration.isLessThan(age, policy.fresh) ? "hit" : "stale";
    return { outcome, answer: answer.value, storedAt: stored.value.storedAt } satisfies Cached<A>;
  });
};

export const answerCache = <I, A, C extends AnswerContext>(
  policy: AnswerPolicy<A>,
  keyOf: (input: I, context: C) => Option.Option<string>,
) => {
  const refreshStarts = new Map<string, number>();
  // Refreshes outlive the request signal. middlewareGen still joins the background fiber's interruption signal.
  const refreshSignal = new AbortController().signal;
  const read = reader(policy);
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

    const cached = yield* read(context.answerCache, key);
    if (cached.outcome === "hit") {
      yield* served(context, policy.procedure, "hit", cached.storedAt);
      return done({ output: cached.answer });
    }
    if (cached.outcome === "stale") {
      if (claimRefresh(refreshStarts, key, yield* Clock.currentTimeMillis, policy.fresh)) {
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
              policy.refused(error)
                ? Effect.andThen(
                    context.answerCache.delete(key),
                    Effect.sync(() => refreshStarts.delete(key)),
                  )
                : Effect.logWarning("Answer refresh failed", {
                    procedure: policy.procedure,
                    error: error instanceof Error ? error.name : typeof error,
                  }),
            ),
          ),
        );
      }
      yield* served(context, policy.procedure, "stale", cached.storedAt);
      return done({ output: cached.answer });
    }
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    const result = yield* next();
    if (policy.keep(result.output)) yield* store(result.output);
    yield* served(context, policy.procedure, "miss", yield* Clock.currentTimeMillis);
    return result;
  });
};
