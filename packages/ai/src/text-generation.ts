import type { JSONSchema7 } from "ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import { type AiError, AiOutputInvalid, AiRequestFailed, AiTimeout } from "./errors.ts";
import type { AiSchema } from "./schema-bridge.ts";

export interface GenerateRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
}

export interface BatchPrompt {
  readonly id: string;
  readonly prompt: string;
}

export interface GenerateBatchRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompts: ReadonlyArray<BatchPrompt>;
}

export type BatchResults<A> = ReadonlyArray<Result.Result<A, AiError>>;

export interface RunRequest {
  readonly jsonSchema: JSONSchema7;
  readonly system: string;
  readonly prompt: string;
}

export interface RunBatchRequest {
  readonly jsonSchema: JSONSchema7;
  readonly system: string;
  readonly prompts: ReadonlyArray<BatchPrompt>;
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
    readonly generateBatch: <A>(request: GenerateBatchRequest<A>) => Effect.Effect<BatchResults<A>, AiError>;
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

const fallbackConcurrency = 4;

export const make = (options: {
  readonly provider: string;
  readonly model: string;
  readonly timeout: Duration.Duration;
  readonly run: (request: RunRequest) => Effect.Effect<RunResult, AiError>;
  readonly batch?: {
    readonly timeout: Duration.Duration;
    readonly run: (
      request: RunBatchRequest,
    ) => Effect.Effect<ReadonlyMap<string, Result.Result<RunResult, AiError>>, AiError>;
  };
}) => {
  const { provider, model, timeout, run, batch } = options;
  const timedOut = (after: Duration.Duration) =>
    new AiTimeout({ operation: "generate", model, timeoutMillis: Duration.toMillis(after) });
  const invalid = new AiOutputInvalid({
    operation: "generate",
    model,
    detail: "structured output does not match the schema",
  });
  const missing = new AiRequestFailed({ operation: "generate", model, detail: "the batch returned no result" });

  const accept =
    <A>(schema: AiSchema<A>) =>
    ({ output, usage }: RunResult) =>
      Effect.all([
        countTokens(model, "input", usage.inputTokens),
        countTokens(model, "output", usage.outputTokens),
      ]).pipe(Effect.andThen(schema.decode(output)), Effect.catchTags({ SchemaError: () => Effect.fail(invalid) }));

  const generateOne = <A>(request: GenerateRequest<A>) =>
    run({ jsonSchema: request.schema.jsonSchema, system: request.system, prompt: request.prompt }).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut(timeout)) }),
      Effect.flatMap(accept(request.schema)),
    );

  const generate = <A>(request: GenerateRequest<A>) =>
    generateOne(request).pipe(portSpan("TextGeneration.generate", { provider, model }));

  const generateEach = <A>(request: GenerateBatchRequest<A>) =>
    Effect.forEach(
      request.prompts,
      ({ prompt }) => Effect.result(generateOne({ schema: request.schema, system: request.system, prompt })),
      { concurrency: fallbackConcurrency },
    );

  const acceptItem = <A>(
    schema: AiSchema<A>,
    item: Result.Result<RunResult, AiError> | undefined,
  ): Effect.Effect<Result.Result<A, AiError>> => {
    if (item === undefined) return Effect.succeed(Result.fail(missing));
    if (Result.isFailure(item)) return Effect.succeed(Result.fail(item.failure));
    return Effect.result(accept(schema)(item.success));
  };

  const generateBatch = <A>(request: GenerateBatchRequest<A>): Effect.Effect<BatchResults<A>, AiError> =>
    (batch === undefined
      ? generateEach(request)
      : batch.run({ jsonSchema: request.schema.jsonSchema, system: request.system, prompts: request.prompts }).pipe(
          Effect.timeoutOrElse({ duration: batch.timeout, orElse: () => Effect.fail(timedOut(batch.timeout)) }),
          Effect.flatMap((results) =>
            Effect.forEach(request.prompts, ({ id }) => acceptItem(request.schema, results.get(id))),
          ),
        )
    ).pipe(portSpan("TextGeneration.generateBatch", { provider, model }));

  return TextGeneration.of({ model, generate, generateBatch });
};
