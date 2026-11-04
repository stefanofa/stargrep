import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { type Answer, NotSettled, untilRouted, waitUntilReady } from "./fresh-stage.ts";

const url = "https://stage.example";
const notReady = new NotSettled({ answer: "GET /budget 500" });
const cloudflare404: Answer = {
  status: 404,
  contentType: "text/html; charset=UTF-8",
  body: "<h1>There is nothing here yet</h1>",
};
const refused: Answer = { status: 401, contentType: "", body: "" };

const runOnTestClock = <A>(body: Effect.Effect<A>) => Effect.runPromise(body.pipe(Effect.provide(TestClock.layer())));

const outcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : `succeeded with ${JSON.stringify(exit.value)}`;

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
        expect(outcome(yield* Fiber.join(fiber))).toBe(
          `Error: ${url} was not ready within 60 s, last answer: GET /budget 500`,
        );
      }),
    ));

  test("gives up at 60 s when a check never answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(waitUntilReady(url, Effect.never)));
        yield* TestClock.adjust("60 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`Error: ${url} was not ready within 60 s, last answer: none`);
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

describe("untilRouted", () => {
  const what = `GET ${url}/budget`;

  test("gives up 60 s after it starts when 404 pages turn into a request that never answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const send = Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now < 58_000 ? Effect.succeed(cloudflare404) : Effect.never,
        );
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send)));
        yield* TestClock.adjust("59 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(outcome(yield* Fiber.join(fiber))).toBe(
          `Error: ${what} did not reach the Worker within 60 s, last answer: Cloudflare's 404 page`,
        );
      }),
    ));

  test("blames the request, not a 404, when the first request never answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, Effect.never)));
        yield* TestClock.adjust("30 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`Error: ${what} sent no answer within 30 s`);
      }),
    ));

  test("resends Cloudflare's 404 page until the Worker answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const send = Effect.sync(() => (++sent < 3 ? cloudflare404 : refused));
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send)));
        yield* TestClock.adjust("3 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`succeeded with ${JSON.stringify(refused)}`);
        expect(sent).toBe(3);
      }),
    ));

  test("returns the Worker's own 404 without resending it", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const workerNotFound: Answer = { status: 404, contentType: "application/json", body: "{}" };
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            untilRouted(
              what,
              Effect.sync(() => {
                sent++;
                return workerNotFound;
              }),
            ),
          ),
        );
        expect(outcome(yield* Fiber.join(fiber))).toBe(`succeeded with ${JSON.stringify(workerNotFound)}`);
        expect(sent).toBe(1);
      }),
    ));
});
