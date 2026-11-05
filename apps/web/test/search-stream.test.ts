import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { type Answer, type Ask, pause, semanticAnswers } from "../src/lib/search-stream.ts";

const typing = Duration.millis(60);

const harness = (latency: Duration.Duration) =>
  Effect.gen(function* () {
    const queries = yield* Queue.unbounded<Ask>();
    const started = yield* Ref.make<ReadonlyArray<string>>([]);
    const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
    const answers = yield* Ref.make<ReadonlyArray<Answer<string, never>>>([]);
    const search = (query: string) =>
      Ref.update(started, (all) => [...all, query]).pipe(
        Effect.andThen(Effect.sleep(latency)),
        Effect.as(`results for ${query}`),
        Effect.onInterrupt(() => Ref.update(interrupted, (all) => [...all, query])),
      );
    yield* semanticAnswers(Stream.fromQueue(queries), search).pipe(
      Stream.runForEach((answer) => Ref.update(answers, (all) => [...all, answer])),
      Effect.forkChild,
    );
    const type = (...steps: ReadonlyArray<string>) =>
      Effect.forEach(
        steps,
        (query) => Queue.offer(queries, { query, round: 0 }).pipe(Effect.andThen(TestClock.adjust(typing))),
        { discard: true },
      );
    const refresh = (query: string) => Queue.offer(queries, { query, round: 1 });
    return {
      type,
      refresh,
      started: Ref.get(started),
      interrupted: Ref.get(interrupted),
      answers: Ref.get(answers).pipe(
        Effect.map((all) => all.map(({ query, result }) => [query, result && Result.getOrThrow(result)])),
      ),
    };
  });

describe("semanticAnswers", () => {
  it.effect("searches only once typing pauses, for the last query typed", () =>
    Effect.gen(function* () {
      const { type, started, answers } = yield* harness(Duration.millis(100));
      yield* type("r", "ru", "rus", "rust", "rust t", "rust tui");
      expect(yield* started).toEqual([]);

      yield* TestClock.adjust(pause);
      expect(yield* started).toEqual(["rust tui"]);
      yield* TestClock.adjust(Duration.millis(100));
      expect(yield* answers).toEqual([["rust tui", "results for rust tui"]]);
    }),
  );

  it.effect("interrupts the request for a query the user typed over and answers only the last one", () =>
    Effect.gen(function* () {
      const { type, started, interrupted, answers } = yield* harness(Duration.seconds(1));
      yield* type("rust tui");
      yield* TestClock.adjust(pause);
      expect(yield* started).toEqual(["rust tui"]);

      yield* type("go cli");
      yield* TestClock.adjust(pause);
      expect(yield* interrupted).toEqual(["rust tui"]);
      expect(yield* started).toEqual(["rust tui", "go cli"]);

      yield* TestClock.adjust(Duration.seconds(2));
      expect(yield* answers).toEqual([["go cli", "results for go cli"]]);
    }),
  );

  it.effect("answers a short or repeated query without a request", () =>
    Effect.gen(function* () {
      const { type, started, answers } = yield* harness(Duration.millis(10));
      yield* type("go cli");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* type("Go  CLI ");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* type("go");
      yield* TestClock.adjust(Duration.seconds(1));

      expect(yield* started).toEqual(["go cli"]);
      expect(yield* answers).toEqual([
        ["go cli", "results for go cli"],
        ["go", undefined],
      ]);
    }),
  );

  it.effect("searches the same query again when asked to refresh", () =>
    Effect.gen(function* () {
      const { type, refresh, started } = yield* harness(Duration.millis(10));
      yield* type("go cli");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* refresh("go cli");
      yield* TestClock.adjust(Duration.seconds(1));

      expect(yield* started).toEqual(["go cli", "go cli"]);
    }),
  );

  it.effect("keeps answering after a search fails", () =>
    Effect.gen(function* () {
      const queries = yield* Queue.unbounded<Ask>();
      const answers = yield* semanticAnswers(Stream.fromQueue(queries), (query) =>
        query === "broken query" ? Effect.fail("unavailable" as const) : Effect.succeed(query.length),
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Queue.offer(queries, { query: "broken query", round: 0 });
      yield* TestClock.adjust(pause);
      yield* Queue.offer(queries, { query: "working query", round: 0 });
      yield* TestClock.adjust(pause);

      const [failed, worked] = yield* Fiber.join(answers);
      expect(failed?.result && Result.isFailure(failed.result)).toBe(true);
      expect(worked).toEqual({ query: "working query", result: Result.succeed(13) });
    }),
  );
});
