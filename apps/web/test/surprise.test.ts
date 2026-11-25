import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { playSurprise } from "../src/lib/surprise.ts";

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
