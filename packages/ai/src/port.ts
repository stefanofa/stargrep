import * as Analytics from "@stargrep/analytics/analytics";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";

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

export interface Call {
  readonly operation: "generate" | "embed";
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
}

export interface CallUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

const failureOf = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => error._tag,
    onNone: () => (Cause.hasInterruptsOnly(cause) ? "Interrupted" : "Defect"),
  });

// Sends each call's model, tokens, latency, and cost to analytics, whatever its outcome, so spend shows per call. The
// prompt and the answer never leave the port.
export const recordCall =
  <A>(call: Call, usageOf: (result: A) => CallUsage) =>
  <E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Clock.currentTimeMillis, (started) =>
      Effect.onExit(effect, (exit) =>
        Effect.gen(function* () {
          const latencyMillis = (yield* Clock.currentTimeMillis) - started;
          const span = yield* Effect.option(Effect.currentSpan);
          const usage: CallUsage = Exit.isSuccess(exit) ? usageOf(exit.value) : {};
          yield* Analytics.capture(
            Analytics.Event.ModelCall({
              ...call,
              latencyMillis,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              costUsd: usage.costUsd,
              error: Exit.isSuccess(exit) ? undefined : failureOf(exit.cause),
              traceId: Option.getOrUndefined(Option.map(span, ({ traceId }) => traceId)),
            }),
          );
        }),
      ),
    );
