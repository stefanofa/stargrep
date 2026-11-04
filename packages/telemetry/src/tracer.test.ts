import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { collectSpans } from "./collector.ts";

describe("withoutResults", () => {
  it.effect("ends a successful span with no value and keeps its attributes and children", () => {
    const { tracer, named } = collectSpans();
    return Effect.gen(function* () {
      const value = yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "item.count": 2 });
        yield* Effect.void.pipe(Effect.withSpan("child"));
        return "PRIVATE_RESULT";
      }).pipe(Effect.withSpan("parent", { attributes: { model: "test/model" } }));

      expect(value).toBe("PRIVATE_RESULT");
      const parent = named("parent");
      expect(parent?.status._tag === "Ended" && parent.status.exit).toEqual(Exit.void);
      expect(Object.fromEntries(parent?.attributes ?? [])).toEqual({ model: "test/model", "item.count": 2 });
      expect(Option.getOrUndefined(named("child")?.parent ?? Option.none())).toBe(parent);
    }).pipe(Effect.withTracer(tracer));
  });

  it.effect("keeps the cause of a failed span", () => {
    const { tracer, named } = collectSpans();
    return Effect.gen(function* () {
      yield* Effect.flip(Effect.fail("bounded").pipe(Effect.withSpan("failing")));
      const span = named("failing");
      expect(span?.status._tag === "Ended" && Exit.findErrorOption(span.status.exit)).toEqual(Option.some("bounded"));
    }).pipe(Effect.withTracer(tracer));
  });

  it.effect("ends the span when the fiber is interrupted", () => {
    const { tracer, named } = collectSpans();
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.never.pipe(Effect.withSpan("interrupted")));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const span = named("interrupted");
      expect(span?.status._tag === "Ended" && Exit.hasInterrupts(span.status.exit)).toBe(true);
    }).pipe(Effect.withTracer(tracer));
  });
});
