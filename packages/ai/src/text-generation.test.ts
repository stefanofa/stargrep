import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AiRequestFailed, AiUnavailable } from "./errors.ts";
import * as Port from "./port.ts";
import { toAiSchema } from "./schema-bridge.ts";
import * as TextGeneration from "./text-generation.ts";

const Answer = toAiSchema(Schema.Struct({ answer: Schema.Finite }));

const service = (run: (request: TextGeneration.RunRequest) => Effect.Effect<TextGeneration.RunResult>) =>
  TextGeneration.make({ provider: "test", model: "seam/model", timeout: Duration.seconds(10), run });

const usage = { inputTokens: 7, outputTokens: 3 };

// Each prompt's answer, in prompt order.
const answers = (generation: TextGeneration.TextGeneration["Service"], prompts: ReadonlyArray<string>) =>
  generation.generateBatch({ schema: Answer, system: "s", items: prompts, prompt: (prompt) => prompt }).pipe(
    Stream.runCollect,
    Effect.map((answered) => {
      const byPrompt = new Map(answered);
      return prompts.map((prompt) => byPrompt.get(prompt));
    }),
  );

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
      const results = yield* answers(generation, ["one", "bad"]);
      expect(prompts.toSorted()).toEqual(["bad", "one"]);
      const [ok, failed] = results;
      expect(ok).toEqual(Result.succeed({ answer: 3 }));
      expect(failed && Result.isFailure(failed) && failed.failure._tag).toBe("AiOutputInvalid");
    }),
  );

  it.effect("sends each batch answer as soon as it is ready, before a slower prompt answers", () =>
    Effect.gen(function* () {
      const slow = yield* Deferred.make<void>();
      const generation = service((request) =>
        Effect.as(request.prompt === "slow" ? Deferred.await(slow) : Effect.void, {
          output: { answer: request.prompt.length },
          usage,
        }),
      );
      const first = yield* generation
        .generateBatch({ schema: Answer, system: "s", items: ["slow", "fast"], prompt: (prompt) => prompt })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(first).toEqual([["fast", Result.succeed({ answer: 4 })]]);
    }),
  );

  it.effect("calls the adapter once, so retries stay with the adapter that knows the provider's retry-after", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const generation = TextGeneration.make({
        provider: "test",
        model: "seam/model",
        timeout: Duration.seconds(10),
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(new AiUnavailable({ operation: "generate", model: "seam/model", detail: "503" }));
          }),
      });
      expect((yield* Effect.flip(generation.generate({ schema: Answer, system: "s", prompt: "p" })))._tag).toBe(
        "AiUnavailable",
      );
      expect(attempts).toBe(1);
    }),
  );

  it.effect("answers a failed batch item with a direct call each time the batch replays the failure", () =>
    Effect.gen(function* () {
      let direct = 0;
      const generation = TextGeneration.make({
        provider: "test",
        model: "seam/model",
        timeout: Duration.seconds(10),
        run: () =>
          Effect.sync(() => {
            direct++;
            return { output: { answer: 2 }, usage };
          }),
        batch: {
          timeout: Duration.hours(1),
          run: () =>
            Effect.succeed([
              Result.succeed({ output: { answer: 1 }, usage }),
              Result.fail(
                new AiRequestFailed({ operation: "generate", model: "seam/model", detail: "batch item failed" }),
              ),
            ]),
        },
      });
      for (const _ of [1, 2]) {
        expect(yield* answers(generation, ["one", "two"])).toEqual([
          Result.succeed({ answer: 1 }),
          Result.succeed({ answer: 2 }),
        ]);
      }
      expect(direct).toBe(2);
    }),
  );

  it.effect("answers prompts beyond a short batch result with direct calls", () =>
    Effect.gen(function* () {
      let direct = 0;
      const generation = TextGeneration.make({
        provider: "test",
        model: "seam/model",
        timeout: Duration.seconds(10),
        run: () =>
          Effect.sync(() => {
            direct++;
            return { output: { answer: 2 }, usage };
          }),
        batch: {
          timeout: Duration.hours(1),
          run: () => Effect.succeed([Result.succeed({ output: { answer: 1 }, usage })]),
        },
      });
      expect(yield* answers(generation, ["one", "two", "three"])).toEqual([
        Result.succeed({ answer: 1 }),
        Result.succeed({ answer: 2 }),
        Result.succeed({ answer: 2 }),
      ]);
      expect(direct).toBe(2);
    }),
  );

  it.effect("answers every prompt directly when the whole batch fails, each time the failed job replays", () =>
    Effect.gen(function* () {
      let direct = 0;
      const generation = TextGeneration.make({
        provider: "test",
        model: "seam/model",
        timeout: Duration.seconds(10),
        run: () =>
          Effect.sync(() => {
            direct++;
            return { output: { answer: 2 }, usage };
          }),
        batch: {
          timeout: Duration.hours(1),
          run: () =>
            Effect.fail(new AiRequestFailed({ operation: "generate", model: "seam/model", detail: "batch failed" })),
        },
      });
      for (const _ of [1, 2]) {
        expect(yield* answers(generation, ["one", "two"])).toEqual([
          Result.succeed({ answer: 2 }),
          Result.succeed({ answer: 2 }),
        ]);
      }
      expect(direct).toBe(4);
    }),
  );

  it.effect("counts the adapter's reported tokens", () =>
    Effect.gen(function* () {
      const input = Metric.withAttributes(Port.tokensUsed, { model: "seam/model", direction: "input" });
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
