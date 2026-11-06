import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import type { AiSpendLimited } from "./errors.ts";
import * as TextGeneration from "./text-generation.ts";

export const callsRefused = Metric.counter("stargrep_ai_calls_refused", {
  description: "Model calls the allowance refused before they reached the model, by limit.",
});

// Wraps the TextGeneration already in context, so every real call first takes from the allowance. A cached plan never
// reaches a model, so it never takes.
export const layer = (take: Effect.Effect<void, AiSpendLimited>) =>
  Layer.effect(
    TextGeneration.TextGeneration,
    Effect.gen(function* () {
      const inner = yield* TextGeneration.TextGeneration;
      const allowed = take.pipe(
        Effect.tapError((refused) => Metric.update(Metric.withAttributes(callsRefused, { limit: refused.limit }), 1)),
      );
      const generate = Effect.fnUntraced(function* <A>(request: TextGeneration.GenerateRequest<A>) {
        yield* allowed;
        return yield* inner.generate(request);
      });
      const generateBatch = Effect.fnUntraced(function* <A>(request: TextGeneration.GenerateBatchRequest<A>) {
        const paid = yield* Effect.result(allowed);
        return Result.isFailure(paid)
          ? request.prompts.map(() => Result.fail(paid.failure))
          : yield* inner.generateBatch(request);
      });
      return TextGeneration.TextGeneration.of({ model: inner.model, generate, generateBatch });
    }),
  );
