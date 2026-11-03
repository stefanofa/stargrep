import type { JSONSchema7 } from "ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import type { AiSchema } from "./schema-bridge.ts";

export interface GenerateRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
}

export interface RunRequest {
  readonly jsonSchema: JSONSchema7;
  readonly system: string;
  readonly prompt: string;
}

export interface RunResult {
  readonly output: unknown;
  readonly usage: { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined };
}

export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    readonly model: string;
    readonly generate: <A>(request: GenerateRequest<A>) => Effect.Effect<A, AiError>;
  }
>()("@stargrep/ai/text-generation/TextGeneration") {}

export const tokensUsed = Metric.counter("stargrep_ai_tokens", {
  description: "Model tokens used, by model and direction.",
});

export const countTokens = (model: string, direction: "input" | "output", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(tokensUsed, { model, direction }), tokens ?? 0);

export const portSpan =
  (name: string, attributes: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.makeSpan(name, { attributes }), (span) =>
      effect.pipe(
        Effect.withParentSpan(span),
        Effect.onExit((exit) =>
          Effect.map(Clock.currentTimeNanos, (now) => span.end(now, Exit.isSuccess(exit) ? Exit.void : exit)),
        ),
      ),
    );

export const make = (options: {
  readonly provider: string;
  readonly model: string;
  readonly timeout: Duration.Duration;
  readonly run: (request: RunRequest) => Effect.Effect<RunResult, AiError>;
}) => {
  const { provider, model, timeout, run } = options;
  const timedOut = new AiTimeout({ operation: "generate", model, timeoutMillis: Duration.toMillis(timeout) });
  const invalid = new AiOutputInvalid({
    operation: "generate",
    model,
    detail: "structured output does not match the schema",
  });
  const generate = <A>(request: GenerateRequest<A>) =>
    run({ jsonSchema: request.schema.jsonSchema, system: request.system, prompt: request.prompt }).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut) }),
      Effect.tap(({ usage }) =>
        Effect.all([countTokens(model, "input", usage.inputTokens), countTokens(model, "output", usage.outputTokens)]),
      ),
      Effect.flatMap(({ output }) =>
        request.schema.decode(output).pipe(Effect.catchTags({ SchemaError: () => Effect.fail(invalid) })),
      ),
      portSpan("TextGeneration.generate", { provider, model }),
    );
  return TextGeneration.of({ model, generate });
};
