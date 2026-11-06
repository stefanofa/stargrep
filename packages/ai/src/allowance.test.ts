import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Allowance from "./allowance.ts";
import { AiSpendLimited } from "./errors.ts";
import * as Fake from "./fake.ts";
import { toAiSchema } from "./schema-bridge.ts";
import * as TextGeneration from "./text-generation.ts";

const Answer = toAiSchema(Schema.Struct({ answer: Schema.Finite }));

const refusedByCaller = Metric.withAttributes(Allowance.callsRefused, { limit: "caller" });

const allowance = (allowed: number) => {
  const events: Array<string> = [];
  let left = allowed;
  const take = Effect.suspend(() => {
    events.push("take");
    if (left === 0) return Effect.fail(new AiSpendLimited({ operation: "generate", limit: "caller" }));
    left--;
    return Effect.void;
  });
  const model = Fake.layerTextGeneration(() => {
    events.push("model");
    return { answer: 42 };
  });
  return { events, layer: Allowance.layer(take).pipe(Layer.provide(model)) };
};

const generate = TextGeneration.TextGeneration.use((generation) =>
  generation.generate({ schema: Answer, system: "s", prompt: "p" }),
);

describe("the model call allowance", () => {
  it.effect("takes from the allowance before each model call, and a refusal never reaches the model", () => {
    const { events, layer } = allowance(1);
    return Effect.gen(function* () {
      const before = (yield* Metric.value(refusedByCaller)).count;
      expect(yield* generate).toEqual({ answer: 42 });
      const refused = yield* Effect.flip(generate);
      expect(refused).toEqual(new AiSpendLimited({ operation: "generate", limit: "caller" }));
      expect(events).toEqual(["take", "model", "take"]);
      expect((yield* Metric.value(refusedByCaller)).count - before).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses every prompt of a batch it cannot pay for, without calling the model", () => {
    const { events, layer } = allowance(0);
    return Effect.gen(function* () {
      const results = yield* TextGeneration.TextGeneration.use((generation) =>
        generation.generateBatch({ schema: Answer, system: "s", prompts: ["a", "b"] }),
      );
      expect(results.map((result) => Result.isFailure(result) && result.failure._tag)).toEqual([
        "AiSpendLimited",
        "AiSpendLimited",
      ]);
      expect(events).toEqual(["take"]);
    }).pipe(Effect.provide(layer));
  });
});
