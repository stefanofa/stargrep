import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";
import type { AiError } from "./errors.ts";

export const unavailableRetry = {
  schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
  times: 3,
  while: (error: AiError) => error._tag === "AiUnavailable",
};

export const tokensUsed = Metric.counter("stargrep_ai_tokens", {
  description: "Model tokens used, by model and direction.",
});

export const countTokens = (model: string, direction: "input" | "output", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(tokensUsed, { model, direction }), tokens ?? 0);
