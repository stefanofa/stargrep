import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { NotReady, waitUntilReady } from "./fresh-stage.ts";

const url = "https://stage.example";
const notReady = new NotReady({ answer: "GET /budget 500" });

const runOnTestClock = <A>(body: Effect.Effect<A>) => Effect.runPromise(body.pipe(Effect.provide(TestClock.layer())));

const defectMessage = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : `succeeded with ${String(exit.value)}`;

describe("waitUntilReady", () => {
  test("gives up 60 s after it starts, even while a slow check is still running", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(waitUntilReady(url, Effect.sleep("50 seconds").pipe(Effect.andThen(Effect.fail(notReady))))),
        );
        yield* TestClock.adjust("59 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(defectMessage(yield* Fiber.join(fiber))).toBe(
          `Error: ${url} was not ready within 60 s, last answer: GET /budget 500`,
        );
      }),
    ));

  test("gives up at 60 s when a check never answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(waitUntilReady(url, Effect.never)));
        yield* TestClock.adjust("60 seconds");
        expect(defectMessage(yield* Fiber.join(fiber))).toBe(
          `Error: ${url} was not ready within 60 s, last answer: none`,
        );
      }),
    ));

  test("returns once a check passes after a few failures", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let attempts = 0;
        const check = Effect.suspend(() => (++attempts < 4 ? Effect.fail(notReady) : Effect.void));
        const fiber = yield* Effect.forkChild(Effect.exit(waitUntilReady(url, check)));
        yield* TestClock.adjust("5 seconds");
        expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
        expect(attempts).toBe(4);
      }),
    ));
});
