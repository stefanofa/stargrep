import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Analytics from "./analytics.ts";

class SweepStalled extends Schema.TaggedError<SweepStalled, { readonly brand: unique symbol }>()("SweepStalled", {
  repos: Schema.Int,
}) {
  override get message() {
    return `The sweep stalled after ${this.repos} repos`;
  }
}

const userId = Brand.nominal<string & Brand.Brand<"UserId">>()("user-1");

describe("Analytics", () => {
  it.effect("names Stargrep unless a caller names the actor", () => {
    const memory = Analytics.layerMemory();
    return Effect.gen(function* () {
      yield* Analytics.capture(Analytics.Event.SummaryGenerated({ model: "anthropic/claude-haiku-5.5" }));
      yield* Analytics.capture(Analytics.Event.SignedUp()).pipe(Analytics.withActor(Analytics.Actor.User({ userId })));
      expect(memory.captured.map(({ actor }) => actor._tag)).toEqual(["Stargrep", "User"]);
    }).pipe(Effect.provide(memory.layer));
  });

  it.effect("turns an error log with a cause into an exception with the failure's type, message, and stack", () => {
    const memory = Analytics.layerMemory();
    return Effect.gen(function* () {
      yield* Effect.logError("Enrich sweep failed", {
        cause: Cause.fail(new SweepStalled({ repos: 4 })),
        traceId: "t1",
      });
      const [captured] = memory.captured;
      if (captured?.event._tag !== "Exception") throw new Error("expected an exception event");
      expect(captured.event.source).toBe("Enrich sweep failed");
      expect(captured.event.traceId).toBe("t1");
      expect(captured.event.thrown[0]?.type).toBe("SweepStalled");
      expect(captured.event.thrown[0]?.value).toBe("The sweep stalled after 4 repos");
      expect(captured.event.thrown[0]?.stack).toContain("SweepStalled");
    }).pipe(Effect.provide(Layer.merge(memory.layer, Analytics.layerLogger)));
  });

  it.effect("turns a defect logged as the cause into an exception", () => {
    const memory = Analytics.layerMemory();
    return Effect.gen(function* () {
      yield* Effect.logError("Queue batch failed", Cause.die(new TypeError("x is undefined")));
      const [captured] = memory.captured;
      if (captured?.event._tag !== "Exception") throw new Error("expected an exception event");
      expect(captured.event.thrown.map(({ type, value }) => ({ type, value }))).toEqual([
        { type: "TypeError", value: "x is undefined" },
      ]);
    }).pipe(Effect.provide(Layer.merge(memory.layer, Analytics.layerLogger)));
  });

  it.effect("names the logged failure when an error log has no cause", () => {
    const memory = Analytics.layerMemory();
    return Effect.gen(function* () {
      yield* Effect.logError("API call failed", { error: "DbQueryFailed", traceId: "t2" });
      expect(memory.captured.map(({ event }) => event)).toEqual([
        Analytics.Event.Exception({
          source: "API call failed",
          thrown: [{ type: "DbQueryFailed", value: "API call failed", stack: undefined }],
          traceId: "t2",
        }),
      ]);
    }).pipe(Effect.provide(Layer.merge(memory.layer, Analytics.layerLogger)));
  });

  it.effect("captures nothing for a warning", () => {
    const memory = Analytics.layerMemory();
    return Effect.gen(function* () {
      yield* Effect.logWarning("Owner sync was not queued", { cause: Cause.fail(new SweepStalled({ repos: 1 })) });
      expect(memory.captured).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(memory.layer, Analytics.layerLogger)));
  });
});
