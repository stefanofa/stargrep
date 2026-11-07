import "@orpc/effect/extensions/effect";
import "@orpc/effect/extensions/schema";
import { describe, expect } from "bun:test";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { createRouterClient, os } from "@orpc/server";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as AnswerCache from "./answer-cache.ts";

const Answer = Schema.Struct({ value: Schema.Finite, planned: Schema.Boolean });
type Answer = typeof Answer.Type;

const policy: AnswerCache.AnswerPolicy<Answer> = {
  procedure: "search",
  json: Schema.fromJsonString(Answer),
  fresh: Duration.minutes(5),
  stale: Duration.days(1),
  keep: (answer) => answer.planned,
};

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {}) {}

// Each refresh is held until the test runs it, so a test can look at what happens while one is in flight.
const harness = (planned: () => boolean = () => true) => {
  const memory = AnswerCache.memory();
  const counts = { computed: 0, builds: 0, admitted: 0 };
  const refreshes: Array<Effect.Effect<void>> = [];
  const resHeaders = new Headers();
  interface CacheContext extends AnswerCache.AnswerContext, WithEffectContext<never> {
    readonly admission: Effect.Effect<void, Refused>;
  }
  const cached = AnswerCache.answerCache(policy, (key: string, _context: CacheContext) => Option.some(key));
  const compute = os
    .$context<CacheContext>()
    .input(Schema.String)
    .output(Answer)
    .use(cached)
    .use(
      middlewareGen<CacheContext>(function* ({ context, next }) {
        counts.builds++;
        if (context.execution === "request") {
          counts.admitted++;
          yield* context.admission;
        }
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
        return yield* next();
      }),
    )
    .handler(() => ({ value: ++counts.computed, planned: planned() }));
  const answer = (key: string, admission: Effect.Effect<void, Refused> = Effect.void, signal?: AbortSignal) =>
    Effect.gen(function* () {
      const context: CacheContext = {
        "effect/context": yield* Effect.context<never>(),
        answerCache: memory.cache,
        background: (run) => Effect.sync(() => refreshes.push(run)),
        resHeaders,
        admission,
        execution: "request",
      };
      const client = createRouterClient({ compute }, { context });
      const found = yield* Effect.tryPromise({
        try: () => client.compute(key, { signal }),
        catch: (error) => {
          if (Schema.is(Refused)(error)) return error;
          throw error;
        },
      });
      return { value: found.value, cache: resHeaders.get("x-answer-cache") };
    });
  const runRefreshes = Effect.suspend(() => Effect.all(refreshes.splice(0)));
  return { memory, counts, refreshes, answer, runRefreshes };
};

describe("answer cache middleware", () => {
  it.effect("refreshes with a background signal after the stale request is aborted", () => {
    const request = new AbortController();
    return Effect.gen(function* () {
      const cache = harness();
      yield* cache.answer("aborted request");
      yield* TestClock.adjust("6 minutes");
      expect(yield* cache.answer("aborted request", Effect.void, request.signal)).toEqual({ value: 1, cache: "stale" });
      request.abort();
      yield* cache.runRefreshes;
      expect(yield* cache.answer("aborted request")).toEqual({ value: 2, cache: "hit" });
      expect(cache.counts).toEqual({ computed: 2, builds: 2, admitted: 1 });
    });
  });

  it.effect("computes on a miss after admitting the call, then serves the answer without services or admission", () =>
    Effect.gen(function* () {
      const cache = harness();
      expect(yield* cache.answer("miss-then-hit")).toEqual({ value: 1, cache: "miss" });
      yield* TestClock.adjust("4 minutes");
      expect(yield* cache.answer("miss-then-hit")).toEqual({ value: 1, cache: "hit" });
      expect(cache.counts).toEqual({ computed: 1, builds: 1, admitted: 1 });
    }),
  );

  it.effect("computes nothing when admission refuses a miss", () =>
    Effect.gen(function* () {
      const cache = harness();
      const refused = yield* cache.answer("refused", Effect.fail(new Refused())).pipe(Effect.flip);
      expect(refused._tag).toBe("Refused");
      expect([cache.counts.computed, cache.memory.entries.size]).toEqual([0, 0]);
    }),
  );

  it.effect("serves a stale answer past 5 minutes while one refresh stores a new one, and misses past a day", () =>
    Effect.gen(function* () {
      const cache = harness();
      yield* cache.answer("stale");
      yield* TestClock.adjust("6 minutes");
      expect(yield* cache.answer("stale")).toEqual({ value: 1, cache: "stale" });
      expect(yield* cache.answer("stale")).toEqual({ value: 1, cache: "stale" });
      expect(cache.refreshes).toHaveLength(1);
      yield* cache.runRefreshes;
      expect(yield* cache.answer("stale")).toEqual({ value: 2, cache: "hit" });

      yield* TestClock.adjust(Duration.sum(Duration.days(1), Duration.minutes(6)));
      expect(yield* cache.answer("stale")).toEqual({ value: 3, cache: "miss" });
      expect(cache.counts).toEqual({ computed: 3, builds: 3, admitted: 2 });
    }),
  );

  it.effect("keeps a refresh that stores nothing from running again for 5 minutes, and serves the stale answer", () =>
    Effect.gen(function* () {
      let planned = true;
      const cache = harness(() => planned);
      yield* cache.answer("unplanned refresh");
      planned = false;
      yield* TestClock.adjust("6 minutes");
      expect(yield* cache.answer("unplanned refresh")).toEqual({ value: 1, cache: "stale" });
      yield* cache.runRefreshes;
      expect(cache.counts.computed).toBe(2);

      yield* TestClock.adjust("4 minutes");
      expect(yield* cache.answer("unplanned refresh")).toEqual({ value: 1, cache: "stale" });
      expect(cache.refreshes).toHaveLength(0);

      yield* TestClock.adjust("1 minute");
      expect(yield* cache.answer("unplanned refresh")).toEqual({ value: 1, cache: "stale" });
      expect(cache.refreshes).toHaveLength(1);
      planned = true;
      yield* cache.runRefreshes;
      expect(yield* cache.answer("unplanned refresh")).toEqual({ value: 3, cache: "hit" });
    }),
  );

  it.effect("never stores an answer the policy does not keep", () =>
    Effect.gen(function* () {
      const cache = harness(() => false);
      expect(yield* cache.answer("never kept")).toEqual({ value: 1, cache: "miss" });
      expect(yield* cache.answer("never kept")).toEqual({ value: 2, cache: "miss" });
      expect(cache.memory.entries.size).toBe(0);
    }),
  );
});
