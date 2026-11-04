import type { JSONSchema7 } from "ai";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import { annotateTokens, countTokens, type Retry, unavailableRetry } from "./port.ts";
import type { AiSchema } from "./schema-bridge.ts";

export interface GenerateRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
}

export interface GenerateBatchRequest<A> extends Omit<GenerateRequest<A>, "prompt"> {
  readonly prompts: ReadonlyArray<string>;
}

export type BatchResults<A> = ReadonlyArray<Result.Result<A, AiError>>;

export interface RunRequest {
  readonly jsonSchema: JSONSchema7;
  readonly system: string;
  readonly prompt: string;
}

export interface RunBatchRequest extends Omit<RunRequest, "prompt"> {
  readonly prompts: ReadonlyArray<string>;
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
    readonly generateBatch: <A>(request: GenerateBatchRequest<A>) => Effect.Effect<BatchResults<A>>;
  }
>()("@stargrep/ai/text-generation/TextGeneration") {}

const fallbackConcurrency = 4;

export const make = (options: {
  readonly provider: string;
  readonly model: string;
  readonly timeout: Duration.Duration;
  readonly retry?: Retry;
  readonly run: (request: RunRequest) => Effect.Effect<RunResult, AiError>;
  readonly batch?: {
    readonly timeout: Duration.Duration;
    readonly run: (
      request: RunBatchRequest,
    ) => Effect.Effect<ReadonlyArray<Result.Result<RunResult, AiError> | undefined>, AiError>;
  };
}) => {
  const { provider, model, timeout, retry = unavailableRetry, run, batch } = options;
  const timedOut = (after: Duration.Duration) =>
    new AiTimeout({ operation: "generate", model, timeoutMillis: Duration.toMillis(after) });
  const invalid = new AiOutputInvalid({
    operation: "generate",
    model,
    detail: "structured output does not match the schema",
  });

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
      Effect.retry(retry),
      Effect.tap(({ usage }) => annotateTokens({ input: usage.inputTokens, output: usage.outputTokens })),
      Effect.flatMap(accept(request.schema)),
    );

  const generate = <A>(request: GenerateRequest<A>) =>
    generateOne(request).pipe(Effect.withSpan("TextGeneration.generate", { attributes: { provider, model } }));

  const answer = <A>(
    request: GenerateBatchRequest<A>,
    prompt: string,
    item: Result.Result<RunResult, AiError> | undefined,
  ) => {
    const direct = generate({ schema: request.schema, system: request.system, prompt });
    const answered =
      item === undefined || Result.isFailure(item)
        ? direct
        : accept(request.schema)(item.success).pipe(Effect.catch(() => direct));
    return Effect.result(answered);
  };

  const runBatch = (request: RunBatchRequest) =>
    batch === undefined
      ? Effect.succeed([])
      : batch.run(request).pipe(
          Effect.timeoutOrElse({ duration: batch.timeout, orElse: () => Effect.fail(timedOut(batch.timeout)) }),
          Effect.catch((error) =>
            Effect.logWarning("Batch failed, answering each prompt directly", { model, error: error._tag }).pipe(
              Effect.as([]),
            ),
          ),
        );

  const generateBatch = <A>(request: GenerateBatchRequest<A>): Effect.Effect<BatchResults<A>> =>
    runBatch({ jsonSchema: request.schema.jsonSchema, system: request.system, prompts: request.prompts }).pipe(
      Effect.flatMap((items) =>
        Effect.forEach(request.prompts, (prompt, index) => answer(request, prompt, items[index]), {
          concurrency: fallbackConcurrency,
        }),
      ),
      Effect.withSpan("TextGeneration.generateBatch", { attributes: { provider, model } }),
    );

  return TextGeneration.of({ model, generate, generateBatch });
};
