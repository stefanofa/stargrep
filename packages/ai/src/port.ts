import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

export const tokensUsed = Metric.counter("stargrep_ai_tokens", {
  description: "Model tokens used, by model and direction.",
});

export const cachedTokens = Metric.counter("stargrep_ai_cached_tokens", {
  description:
    "Input tokens the provider read from or wrote to its prompt cache, by model. A share of the input count.",
});

export const reasoningTokens = Metric.counter("stargrep_ai_reasoning_tokens", {
  description: "Output tokens the model spent thinking, by model. A share of the output count.",
});

export const countTokens = (model: string, direction: "input" | "output", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(tokensUsed, { model, direction }), tokens ?? 0);

export const countCachedTokens = (model: string, cache: "read" | "write", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(cachedTokens, { model, cache }), tokens ?? 0);

export const countReasoningTokens = (model: string, tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(reasoningTokens, { model }), tokens ?? 0);

export const annotateTokens = (usage: { readonly input?: number | undefined; readonly output?: number | undefined }) =>
  Effect.annotateCurrentSpan({
    ...(usage.input === undefined ? {} : { "gen_ai.usage.input_tokens": usage.input }),
    ...(usage.output === undefined ? {} : { "gen_ai.usage.output_tokens": usage.output }),
  });

export const tokensSpent = (model: string) =>
  Effect.all({
    input: Metric.value(Metric.withAttributes(tokensUsed, { model, direction: "input" })),
    output: Metric.value(Metric.withAttributes(tokensUsed, { model, direction: "output" })),
    cacheRead: Metric.value(Metric.withAttributes(cachedTokens, { model, cache: "read" })),
    cacheWrite: Metric.value(Metric.withAttributes(cachedTokens, { model, cache: "write" })),
    reasoning: Metric.value(Metric.withAttributes(reasoningTokens, { model })),
  }).pipe(
    Effect.map(({ input, output, cacheRead, cacheWrite, reasoning }) => ({
      input: input.count,
      output: output.count,
      cacheRead: cacheRead.count,
      cacheWrite: cacheWrite.count,
      reasoning: reasoning.count,
    })),
  );
