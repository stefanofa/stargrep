import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

export const tokensUsed = Metric.counter("stargrep_ai_tokens", {
  description: "Model tokens used, by model and direction.",
});

export const countTokens = (model: string, direction: "input" | "output", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(tokensUsed, { model, direction }), tokens ?? 0);

export const annotateTokens = (usage: { readonly input?: number | undefined; readonly output?: number | undefined }) =>
  Effect.annotateCurrentSpan({
    ...(usage.input === undefined ? {} : { "gen_ai.usage.input_tokens": usage.input }),
    ...(usage.output === undefined ? {} : { "gen_ai.usage.output_tokens": usage.output }),
  });

export const tokensSpent = (model: string) =>
  Effect.all({
    input: Metric.value(Metric.withAttributes(tokensUsed, { model, direction: "input" })),
    output: Metric.value(Metric.withAttributes(tokensUsed, { model, direction: "output" })),
  }).pipe(Effect.map(({ input, output }) => ({ input: input.count, output: output.count })));
