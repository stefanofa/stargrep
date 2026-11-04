import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { toAiSchema } from "./schema-bridge.ts";
import * as TextGeneration from "./text-generation.ts";

const Answer = toAiSchema(Schema.Struct({ answer: Schema.Finite }));

const service = (run: (request: TextGeneration.RunRequest) => Effect.Effect<TextGeneration.RunResult>) =>
  TextGeneration.make({ provider: "test", model: "seam/model", timeout: Duration.seconds(10), run });

const usage = { inputTokens: 7, outputTokens: 3 };

describe("TextGeneration.make", () => {
  it.effect("hands the adapter the JSON schema and decodes its output", () =>
    Effect.gen(function* () {
      let sent: TextGeneration.RunRequest | undefined;
      const generation = service((request) =>
        Effect.sync(() => {
          sent = request;
          return { output: { answer: 42 }, usage };
        }),
      );
      expect(yield* generation.generate({ schema: Answer, system: "s", prompt: "p" })).toEqual({ answer: 42 });
      expect(sent?.jsonSchema).toBe(Answer.jsonSchema);
    }),
  );

  it.effect("turns output that misses the schema into AiOutputInvalid without the output", () =>
    Effect.gen(function* () {
      const generation = service(() => Effect.succeed({ output: { answer: "forty-two" }, usage }));
      const error = yield* Effect.flip(generation.generate({ schema: Answer, system: "s", prompt: "p" }));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(JSON.stringify(error)).not.toContain("forty-two");
    }),
  );

  it.effect("fails with AiTimeout once the clock passes the adapter's timeout", () =>
    Effect.gen(function* () {
      const generation = service(() => Effect.never);
      const fiber = yield* Effect.forkChild(
        Effect.flip(generation.generate({ schema: Answer, system: "s", prompt: "p" })),
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("Model 'seam/model' did not answer 'generate' within 10000 ms");
    }),
  );

  it.effect("answers a batch through one call per prompt when the adapter has no batch API", () =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      const generation = service((request) =>
        Effect.sync(() => {
          prompts.push(request.prompt);
          return { output: { answer: request.prompt === "bad" ? "nope" : request.prompt.length }, usage };
        }),
      );
      const results = yield* generation.generateBatch({
        schema: Answer,
        system: "s",
        prompts: [
          { id: "a", prompt: "one" },
          { id: "b", prompt: "bad" },
        ],
      });
      expect(prompts.toSorted()).toEqual(["bad", "one"]);
      const [ok, failed] = results;
      expect(ok).toEqual(Result.succeed({ answer: 3 }));
      expect(failed && Result.isFailure(failed) && failed.failure._tag).toBe("AiOutputInvalid");
    }),
  );

  it.effect("counts the adapter's reported tokens", () =>
    Effect.gen(function* () {
      const input = Metric.withAttributes(TextGeneration.tokensUsed, { model: "seam/model", direction: "input" });
      const before = (yield* Metric.value(input)).count;
      yield* service(() => Effect.succeed({ output: { answer: 1 }, usage })).generate({
        schema: Answer,
        system: "s",
        prompt: "p",
      });
      expect((yield* Metric.value(input)).count - before).toBe(7);
    }),
  );
});
