import type { JSONSchema7 } from "ai";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import { annotateTokens, countCachedTokens, countTokens } from "./port.ts";
import type { AiSchema } from "./schema-bridge.ts";

// Whether the model may think before it answers, and how much: the AI SDK's levels. A provider's default can be adaptive
// thinking, which bills every answer for tokens nobody reads, so each prompt states it.
export const Reasoning = Schema.Literals([
  "none",
  "provider-default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type Reasoning = typeof Reasoning.Type;

export interface GenerateRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
  readonly reasoning: Reasoning;
}

export interface GenerateBatchRequest<A, I> extends Omit<GenerateRequest<A>, "prompt"> {
  readonly items: ReadonlyArray<I>;
  readonly prompt: (item: I) => string;
}

// Each item with its answer, sent as soon as that answer is ready, so a caller can keep it before the slowest arrives.
export type BatchAnswer<A, I> = readonly [item: I, answer: Result.Result<A, AiError>];

export interface RunRequest {
  readonly jsonSchema: JSONSchema7;
  readonly system: string;
  readonly prompt: string;
  readonly reasoning: Reasoning;
}

export interface RunBatchRequest extends Omit<RunRequest, "prompt"> {
  readonly prompts: ReadonlyArray<string>;
}

export interface RunResult {
  readonly output: unknown;
  // inputTokens counts every input token, cached or not. cacheReadTokens and cacheWriteTokens are the shares of it the
  // provider read from or wrote to its prompt cache, and reasoningTokens the share of outputTokens the model spent
  // thinking, when the provider reports them.
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly reasoningTokens?: number | undefined;
    readonly cacheReadTokens?: number | undefined;
    readonly cacheWriteTokens?: number | undefined;
  };
}

export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    // Who answers: a provider such as the gateway, the claude-code CLI, or the fake stand-in.
    readonly provider: string;
    readonly model: string;
    // How long a batch of two or more prompts may wait for its answers, when the provider has a batch API.
    readonly batchTimeout: Option.Option<Duration.Duration>;
    readonly generate: <A>(request: GenerateRequest<A>) => Effect.Effect<A, AiError>;
    readonly generateBatch: <A, I>(request: GenerateBatchRequest<A, I>) => Stream.Stream<BatchAnswer<A, I>>;
  }
>()("@stargrep/ai/text-generation/TextGeneration") {}

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
    ) => Effect.Effect<ReadonlyArray<Result.Result<RunResult, AiError> | undefined>, AiError>;
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

  const accept =
    <A>(schema: AiSchema<A>) =>
    ({ output, usage }: RunResult) =>
      Effect.all([
        countTokens(model, "input", usage.inputTokens),
        countTokens(model, "output", usage.outputTokens),
        countCachedTokens(model, "read", usage.cacheReadTokens),
        countCachedTokens(model, "write", usage.cacheWriteTokens),
      ]).pipe(Effect.andThen(schema.decode(output)), Effect.catchTags({ SchemaError: () => Effect.fail(invalid) }));

  const generateOne = <A>(request: GenerateRequest<A>) =>
    run({
      jsonSchema: request.schema.jsonSchema,
      system: request.system,
      prompt: request.prompt,
      reasoning: request.reasoning,
    }).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut(timeout)) }),
      Effect.tap(({ usage }) => annotateTokens({ input: usage.inputTokens, output: usage.outputTokens })),
      Effect.flatMap(accept(request.schema)),
    );

  const generate = <A>(request: GenerateRequest<A>) =>
    generateOne(request).pipe(Effect.withSpan("TextGeneration.generate", { attributes: { provider, model } }));

  const answer = <A>(
    request: Omit<GenerateRequest<A>, "prompt">,
    prompt: string,
    item: Result.Result<RunResult, AiError> | undefined,
  ) => {
    const direct = generate({ schema: request.schema, system: request.system, prompt, reasoning: request.reasoning });
    const answered =
      item === undefined || Result.isFailure(item)
        ? direct
        : accept(request.schema)(item.success).pipe(Effect.catch(() => direct));
    return Effect.result(answered);
  };

  // A batch job of one prompt only adds minutes of waiting, so that prompt is answered directly.
  const runBatch = (request: RunBatchRequest) =>
    batch === undefined || request.prompts.length < 2
      ? Effect.succeed([])
      : batch.run(request).pipe(
          Effect.timeoutOrElse({ duration: batch.timeout, orElse: () => Effect.fail(timedOut(batch.timeout)) }),
          Effect.catch((error) =>
            Effect.logWarning("Batch failed, answering each prompt directly", { model, error: error._tag }).pipe(
              Effect.as([]),
            ),
          ),
        );

  const generateBatch = <A, I>(request: GenerateBatchRequest<A, I>): Stream.Stream<BatchAnswer<A, I>> => {
    const asked = request.items.map((item) => ({ item, prompt: request.prompt(item) }));
    const prompts = asked.map(({ prompt }) => prompt);
    const { jsonSchema } = request.schema;
    return Stream.fromEffect(
      runBatch({ jsonSchema, system: request.system, prompts, reasoning: request.reasoning }),
    ).pipe(
      Stream.flatMap((results) =>
        Stream.fromIterable(asked.map((entry, index) => ({ ...entry, result: results[index] }))),
      ),
      Stream.mapEffect(
        ({ item, prompt, result }) =>
          Effect.map(answer(request, prompt, result), (answered): BatchAnswer<A, I> => [item, answered]),
        { concurrency: fallbackConcurrency, unordered: true },
      ),
      Stream.withSpan("TextGeneration.generateBatch", { attributes: { provider, model } }),
    );
  };

  return TextGeneration.of({
    provider,
    model,
    batchTimeout: Option.map(Option.fromUndefinedOr(batch), (api) => api.timeout),
    generate,
    generateBatch,
  });
};
