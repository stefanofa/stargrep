import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { playReveal, playSurprise } from "../src/lib/reveal-timing.ts";

it.effect("reveals one character every 20ms and settles for 400ms", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const fiber = yield* Effect.forkChild(
      playReveal("rust", {
        typed: (text) => events.push(text),
        settled: () => events.push("settled"),
        done: () => events.push("done"),
      }),
    );
    yield* TestClock.adjust("19 millis");
    expect(events).toEqual([]);
    yield* TestClock.adjust("1 millis");
    expect(events).toEqual(["r"]);
    yield* TestClock.adjust("60 millis");
    expect(events).toEqual(["r", "ru", "rus", "rust", "settled"]);
    yield* TestClock.adjust("399 millis");
    expect(events.at(-1)).toBe("settled");
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);
    expect(events.at(-1)).toBe("done");
  }),
);

it.effect("interrupting a reveal stops every later character and phase", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const fiber = yield* Effect.forkChild(
      playReveal("rust", {
        typed: (text) => events.push(text),
        settled: () => events.push("settled"),
        done: () => events.push("done"),
      }),
    );
    yield* TestClock.adjust("40 millis");
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 hour");
    expect(events).toEqual(["r", "ru"]);
  }),
);

it.effect("surprises the mascot after its quiet period, once, for 1200ms", () =>
  Effect.gen(function* () {
    const poses: Array<boolean> = [];
    const fiber = yield* Effect.forkChild(playSurprise(600, (value) => poses.push(value)));
    yield* TestClock.adjust("599 millis");
    expect(poses).toEqual([]);
    yield* TestClock.adjust("1 millis");
    expect(poses).toEqual([true]);
    yield* TestClock.adjust("1199 millis");
    expect(poses).toEqual([true]);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);
    yield* TestClock.adjust("1 hour");
    expect(poses).toEqual([true, false]);
  }),
);
