import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ApiServices, type BuildServices, withServices } from "./services.ts";

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
  readonly services: BuildServices;
  // Runs after the response, with services of its own, because the request's services close when it returns.
  readonly background: (run: Effect.Effect<void, never, ApiServices>) => Effect.Effect<void>;
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
const refreshStarts = new Map<string, number>();

const claimRefresh = (key: string, now: number, every: Duration.Duration) => {
  for (const [started, at] of refreshStarts) {
    if (now - at < Duration.toMillis(every)) break;
    refreshStarts.delete(started);
  }
  if (refreshStarts.has(key)) return false;
  refreshStarts.set(key, now);
  return true;
};

// Serves a stored answer while it is fresh, and while it is stale too as a refresh runs in the background. A miss
// builds the request's services, admits the call, and computes the answer.
export const cachedAnswer = Effect.fnUntraced(function* <A, E extends { readonly _tag: string }, F>(
  context: AnswerContext,
  policy: AnswerPolicy<A>,
  key: string,
  compute: Effect.Effect<A, E, ApiServices>,
  admit: Effect.Effect<void, F, ApiServices>,
) {
  const keepFor = Duration.sum(policy.fresh, policy.stale);
  const store = (answer: A) =>
    Schema.encodeEffect(policy.json)(answer).pipe(
      Effect.flatMap((body) => context.answerCache.set(key, body, keepFor)),
      Effect.catchTags({
        SchemaError: () => Effect.logWarning("Answer does not encode", { procedure: policy.procedure }),
      }),
    );

  const stored = yield* context.answerCache.get(key);
  if (Option.isSome(stored)) {
    const now = yield* Clock.currentTimeMillis;
    const answer = yield* Effect.option(Schema.decodeEffect(policy.json)(stored.value.body));
    const age = Duration.millis(Math.max(0, now - stored.value.storedAt));
    if (Option.isSome(answer) && Duration.isLessThan(age, keepFor)) {
      if (Duration.isLessThan(age, policy.fresh)) {
        yield* served(context, policy.procedure, "hit");
        return answer.value;
      }
      if (claimRefresh(key, now, policy.fresh)) {
        yield* context.background(
          compute.pipe(
            Effect.flatMap((fresh) =>
              policy.keep(fresh)
                ? Effect.andThen(
                    store(fresh),
                    Effect.sync(() => refreshStarts.delete(key)),
                  )
                : Effect.void,
            ),
            Effect.catch((error) =>
              Effect.logWarning("Answer refresh failed", { procedure: policy.procedure, error: error._tag }),
            ),
          ),
        );
      }
      yield* served(context, policy.procedure, "stale");
      return answer.value;
    }
  }
  const answer = yield* withServices(context.services, Effect.andThen(admit, compute));
  if (policy.keep(answer)) yield* store(answer);
  yield* served(context, policy.procedure, "miss");
  return answer;
});
