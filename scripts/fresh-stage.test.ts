import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import {
  type Answer,
  NotSettled,
  type Resends,
  untilRouted,
  waitUntilConsumed,
  waitUntilReady,
} from "./fresh-stage.ts";

const url = "https://stage.example";
const notReady = new NotSettled({ answer: "GET /budget 500" });
const cloudflare404: Answer = {
  status: 404,
  contentType: "text/html; charset=UTF-8",
  body: "<h1>There is nothing here yet</h1>",
};
// Trimmed from the page a fresh stage's debug Worker host answered in CI.
const scriptNotFound: Answer = {
  status: 500,
  contentType: "text/html; charset=UTF-8",
  body: [
    "<title>Script not found | pr-141-debug.stargrep.com | Cloudflare</title>",
    '<span class="cf-error-code">1104</span>',
    '<h2 class="cf-subheadline" data-translate="error_desc">Script not found</h2>',
  ].join("\n"),
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

describe("waitUntilConsumed", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `job-${index}`);

  test("allows a slow consumer to start with one batch read per check", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let reads = 0;
        const read = Effect.map(Clock.currentTimeMillis, (now) => {
          reads++;
          return now < 45_000 ? [] : ids;
        });
        const fiber = yield* Effect.forkChild(waitUntilConsumed(ids, read));
        yield* TestClock.adjust("45 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(ids);
        expect(reads).toBe(46);
      }),
    ));

  test("names the missing receipts when consumption misses its deadline", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let reads = 0;
        const read = Effect.sync(() => {
          reads++;
          return ids.slice(0, 8);
        });
        const fiber = yield* Effect.forkChild(Effect.exit(waitUntilConsumed(ids, read)));
        yield* TestClock.adjust("60 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(
          "Error: Queue consumption did not finish within 60 s, last answer: 8/10 consumed; missing: job-8, job-9",
        );
        expect(reads).toBeLessThanOrEqual(61);
      }),
    ));
});

describe("untilRouted", () => {
  const what = `GET ${url}/budget`;
  const noResends = (): Resends => ({ cloudflare404: 0, dropped: 0 });
  const failure = (reason: HttpClientError.HttpClientErrorReason) => new HttpClientError.HttpClientError({ reason });
  const request = HttpClientRequest.get(`${url}/budget`);
  const connectionReset = failure(
    new HttpClientError.TransportError({ request, cause: new Error("read ECONNRESET"), description: "fetch failed" }),
  );

  test("gives up 60 s after it starts when 404 pages turn into a request that never answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        const send = Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now < 58_000 ? Effect.succeed(cloudflare404) : Effect.never,
        );
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send, noResends())));
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
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, Effect.never, noResends())));
        yield* TestClock.adjust("30 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`Error: ${what} sent no answer within 30 s`);
      }),
    ));

  test("resends Cloudflare's 404 page until the Worker answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const resends = noResends();
        const send = Effect.sync(() => (++sent < 3 ? cloudflare404 : refused));
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send, resends)));
        yield* TestClock.adjust("3 seconds");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`succeeded with ${JSON.stringify(refused)}`);
        expect(sent).toBe(3);
        expect(resends).toEqual({ cloudflare404: 2, dropped: 0 });
      }),
    ));

  test("resends Cloudflare's Script not found page until the Worker answers", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const send = Effect.sync(() => (++sent < 3 ? scriptNotFound : refused));
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send, noResends())));
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
              noResends(),
            ),
          ),
        );
        expect(outcome(yield* Fiber.join(fiber))).toBe(`succeeded with ${JSON.stringify(workerNotFound)}`);
        expect(sent).toBe(1);
      }),
    ));

  test("sends once more after a connection drops before any answer", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const resends = noResends();
        const send = Effect.suspend(() => (++sent === 1 ? Effect.fail(connectionReset) : Effect.succeed(refused)));
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send, resends)));
        yield* TestClock.adjust("1 second");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`succeeded with ${JSON.stringify(refused)}`);
        expect(sent).toBe(2);
        expect(resends).toEqual({ cloudflare404: 0, dropped: 1 });
      }),
    ));

  test("fails with the transport error when the connection drops twice", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const resends = noResends();
        const send = Effect.suspend(() => {
          sent++;
          return Effect.fail(connectionReset);
        });
        const fiber = yield* Effect.forkChild(Effect.exit(untilRouted(what, send, resends)));
        yield* TestClock.adjust("1 second");
        expect(outcome(yield* Fiber.join(fiber))).toBe(`HttpClientError: ${connectionReset.message}`);
        expect(connectionReset.message).toBe(`Transport: fetch failed (GET ${url}/budget)`);
        expect(sent).toBe(2);
        expect(resends).toEqual({ cloudflare404: 0, dropped: 1 });
      }),
    ));

  test("never resends a failure that came after an answer", () =>
    runOnTestClock(
      Effect.gen(function* () {
        let sent = 0;
        const response = HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        const unreadable = failure(
          new HttpClientError.DecodeError({ request, response, description: "body ended early" }),
        );
        const send = Effect.suspend(() => {
          sent++;
          return Effect.fail(unreadable);
        });
        const exit = yield* Effect.exit(untilRouted(what, send, noResends()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(sent).toBe(1);
      }),
    ));
});
