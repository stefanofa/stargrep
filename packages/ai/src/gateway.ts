import { createGateway, GatewayError, GatewayModelNotFoundError, type GatewayProvider } from "@ai-sdk/gateway";
import {
  APICallError,
  embedMany,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  type EmbeddingModel as SdkEmbeddingModel,
  type LanguageModel as SdkLanguageModel,
} from "ai";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Batches from "./batches.ts";
import * as Embeddings from "./embeddings.ts";
import {
  type AiError,
  AiKeyMissing,
  AiModelNotFound,
  AiOutputInvalid,
  AiRequestFailed,
  AiUnavailable,
  type Operation,
} from "./errors.ts";
import * as Models from "./models.ts";
import * as TextGeneration from "./text-generation.ts";

type BatchApi = ReturnType<GatewayProvider["experimental_batch"]>;
type BatchItem = Awaited<ReturnType<BatchApi["doGetBatchResults"]>> extends ReadableStream<infer Item> ? Item : never;

export class AiProvider extends Context.Service<
  AiProvider,
  {
    readonly languageModel: (modelId: string) => SdkLanguageModel;
    readonly embeddingModel: (modelId: string) => SdkEmbeddingModel;
    readonly experimental_batch: () => BatchApi;
  }
>()("@stargrep/ai/gateway/AiProvider") {}

const textTimeout = Duration.seconds(60);
const embedTimeout = Duration.seconds(30);
const batchTimeout = Duration.hours(24);
const batchPollInterval = Duration.seconds(10);
// The SDK retries a model request that the provider marks retryable, inside the port's timeout. It waits as long as a
// retry-after under a minute asks. The batch API has no SDK retries, so its calls retry here as many times.
const retries = 3;
const batchCallRetry = {
  schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
  times: retries,
  while: (error: AiError) => error._tag === "AiUnavailable",
};

const silenceSdkWarnings = () => {
  globalThis.AI_SDK_LOG_WARNINGS = false;
};

const detailOf = (cause: unknown) => {
  if (APICallError.isInstance(cause)) return `${cause.name} with status ${cause.statusCode ?? "none"}`;
  if (GatewayError.isInstance(cause)) return `${cause.name} with status ${cause.statusCode}`;
  return cause instanceof Error ? cause.name : "unknown error";
};

const isRetryable = (cause: unknown) =>
  (APICallError.isInstance(cause) || GatewayError.isInstance(cause)) && cause.isRetryable;

const fromSdkError = (operation: Operation, model: string) => (thrown: unknown) => {
  const cause = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
  const attempts = RetryError.isInstance(thrown) ? ` after ${thrown.errors.length} attempts` : "";
  if (GatewayModelNotFoundError.isInstance(cause)) return new AiModelNotFound({ model });
  if (NoObjectGeneratedError.isInstance(cause))
    return new AiOutputInvalid({ operation, model, detail: "the model did not return a JSON object" });
  if (isRetryable(cause)) return new AiUnavailable({ operation, model, detail: `${detailOf(cause)}${attempts}` });
  return new AiRequestFailed({ operation, model, detail: `${detailOf(cause)}${attempts}` });
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const batchItemResult = (model: string, item: BatchItem): Effect.Effect<TextGeneration.RunResult, AiError> => {
  if (item.type !== "text") {
    return Effect.fail(new AiRequestFailed({ operation: "generate", model, detail: "batch item is not text" }));
  }
  if (item.status !== "succeeded") {
    const code = item.error?.code ?? item.error?.type;
    return Effect.fail(
      new AiRequestFailed({
        operation: "generate",
        model,
        detail: `batch item ${item.status}${code === undefined ? "" : ` with ${code}`}`,
      }),
    );
  }
  const text = item.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  return decodeJson(text).pipe(
    Effect.map((output) => ({
      output,
      usage: {
        inputTokens: item.result.usage.inputTokens.total,
        outputTokens: item.result.usage.outputTokens.total,
        reasoningTokens: item.result.usage.outputTokens.reasoning,
      },
    })),
    Effect.catchTags({
      SchemaError: () =>
        Effect.fail(
          new AiOutputInvalid({ operation: "generate", model, detail: "the model did not return a JSON object" }),
        ),
    }),
  );
};

type BatchStatus = Awaited<ReturnType<BatchApi["doGetBatchStatus"]>>;

const batchApi = (provider: AiProvider["Service"], model: string) => {
  const call = <A>(run: (abortSignal: AbortSignal) => PromiseLike<A>) =>
    Effect.tryPromise({ try: run, catch: fromSdkError("generate", model) }).pipe(Effect.retry(batchCallRetry));

  const start = Effect.fn("Gateway.startBatch")(function* (request: Batches.BatchRequest) {
    const key = yield* Batches.requestKey(request);
    const started = yield* call((abortSignal) =>
      provider.experimental_batch().doStartBatch({
        requests: request.prompts.map((prompt, index) => ({
          id: String(index),
          type: "text" as const,
          modelId: request.model,
          options: {
            prompt: [
              { role: "system" as const, content: request.system },
              { role: "user" as const, content: [{ type: "text" as const, text: prompt }] },
            ],
            responseFormat: { type: "json" as const, schema: request.jsonSchema },
          },
        })),
        providerOptions: { gateway: { idempotencyKey: key } },
        abortSignal,
      }),
    );
    yield* Effect.annotateCurrentSpan({ "ai.batch.id": started.batchId, "ai.batch.size": request.prompts.length });
    yield* Effect.logInfo("Gateway batch started", {
      batchId: started.batchId,
      requests: request.prompts.length,
      status: started.rawStatus ?? started.status,
    });
    return started;
  });

  const poll = (batchId: string) =>
    call((abortSignal) => provider.experimental_batch().doGetBatchStatus({ batchId, abortSignal })).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(batchPollInterval),
        until: (status) => status.status !== "pending",
      }),
    );

  const read = Effect.fnUntraced(function* (batchId: string, finished: BatchStatus, size: number) {
    yield* Effect.logInfo("Gateway batch finished", {
      batchId,
      status: finished.rawStatus ?? finished.status,
      completed: finished.requestCounts?.completed ?? null,
      failed: finished.requestCounts?.failed ?? null,
    });
    if (finished.status === "failed") {
      const code = finished.error?.code ?? finished.error?.type ?? "no code";
      return yield* new AiRequestFailed({ operation: "generate", model, detail: `batch failed with ${code}` });
    }
    const items = yield* call(async (abortSignal) => {
      const reader = (await provider.experimental_batch().doGetBatchResults({ batchId, abortSignal })).getReader();
      const read: Array<BatchItem> = [];
      for (let next = await reader.read(); !next.done; next = await reader.read()) read.push(next.value);
      return read;
    });
    const byId = new Map<string, BatchItem>(items.map((item) => [item.id, item]));
    return yield* Effect.forEach(Arr.makeBy(size, String), (id) => {
      const item = byId.get(id);
      return item === undefined ? Effect.undefined : Effect.result(batchItemResult(model, item));
    });
  });

  // A batch the start found already finished, such as a replay of one paid for earlier, is read without polling.
  const run = Effect.fn("Gateway.runBatch")(function* (request: TextGeneration.RunBatchRequest) {
    const started = yield* start({ model, ...request });
    const finished = started.status !== "pending" ? started : yield* poll(started.batchId);
    return yield* read(started.batchId, finished, request.prompts.length);
  });

  const submit = (request: Batches.BatchRequest) => Effect.map(start(request), (started) => started.batchId);

  const collect = Effect.fn("Gateway.collectBatch")(function* (batchId: string, size: number) {
    return yield* read(batchId, yield* poll(batchId), size);
  });

  return { run, submit, collect };
};

export interface TextOptions {
  readonly reasoning: "none" | "provider-default";
  readonly timeout: Duration.Duration;
  readonly maxRetries: number;
  readonly batch: boolean;
}

const defaultTextOptions: TextOptions = {
  reasoning: "provider-default",
  timeout: textTimeout,
  maxRetries: retries,
  batch: true,
};

export const layerTextGeneration = (model: string, options: Partial<TextOptions> = {}) => {
  const { reasoning, timeout, maxRetries, batch } = { ...defaultTextOptions, ...options };
  return Layer.effect(
    TextGeneration.TextGeneration,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) =>
        TextGeneration.make({
          provider: "gateway",
          model,
          timeout,
          run: (request) =>
            Effect.tryPromise({
              try: (abortSignal) =>
                generateText({
                  model: provider.languageModel(model),
                  output: Output.object({ schema: jsonSchema(request.jsonSchema) }),
                  system: request.system,
                  prompt: request.prompt,
                  maxRetries,
                  abortSignal,
                  reasoning,
                }),
              catch: fromSdkError("generate", model),
            }).pipe(
              Effect.flatMap((result) =>
                // The SDK's output getter throws when the last step stopped without text, such as on a length limit.
                Effect.try({
                  try: () => ({
                    output: result.output,
                    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
                  }),
                  catch: (cause) =>
                    NoOutputGeneratedError.isInstance(cause)
                      ? new AiOutputInvalid({
                          operation: "generate",
                          model,
                          detail: `the model returned no output, finish reason ${result.finishReason}`,
                        })
                      : fromSdkError("generate", model)(cause),
                }),
              ),
            ),
          ...(batch ? { batch: { timeout: batchTimeout, run: batchApi(provider, model).run } } : {}),
        }),
      ),
    ),
  );
};

export const layerEmbeddings = (model: Models.EmbeddingModel) =>
  Layer.effect(
    Embeddings.Embeddings,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) =>
        Embeddings.make({
          provider: "gateway",
          model,
          timeout: embedTimeout,
          run: (values) =>
            Effect.tryPromise({
              try: (abortSignal) =>
                embedMany({
                  model: provider.embeddingModel(model.id),
                  values: [...values],
                  dimensions: model.dimensions,
                  maxRetries: retries,
                  abortSignal,
                }),
              catch: fromSdkError("embed", model.id),
            }).pipe(Effect.map((result) => ({ vectors: result.embeddings, tokens: result.usage.tokens }))),
        }),
      ),
    ),
  );

// The batch API alone, for a caller that keeps its own manifest of what it sent, such as the prefill.
export const layerBatches = (model: string) =>
  Layer.effect(
    Batches.Batches,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) => {
        const { submit, collect } = batchApi(provider, model);
        return Batches.Batches.of({ provider: "gateway", model, submit, collect });
      }),
    ),
  );

export const keyMissingText = (model: string) =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({
      provider: "gateway",
      model,
      timeout: textTimeout,
      run: Effect.fn("Gateway.keyMissing")(function* () {
        return yield* new AiKeyMissing({ operation: "generate", model });
      }),
    }),
  );

export const keyMissingEmbeddings = (model: Models.EmbeddingModel) =>
  Layer.succeed(
    Embeddings.Embeddings,
    Embeddings.make({
      provider: "gateway",
      model,
      timeout: embedTimeout,
      run: Effect.fn("Gateway.keyMissing")(function* () {
        return yield* new AiKeyMissing({ operation: "embed", model: model.id });
      }),
    }),
  );

export const layerKeyMissing = Layer.merge(
  keyMissingText(Models.summaryModel),
  keyMissingEmbeddings(Models.embeddingModel),
);

export const layerProvider = (config: { readonly apiKey: Redacted.Redacted<string> }) =>
  Layer.sync(AiProvider, () => AiProvider.of(createGateway({ apiKey: Redacted.value(config.apiKey) })));

export const apiKeyName = "AI_GATEWAY_API_KEY";

export const layerProviderConfig = Layer.unwrap(
  Config.Redacted(apiKeyName).pipe(Effect.map((apiKey) => layerProvider({ apiKey }))),
);

export const layerPlanner = layerTextGeneration(Models.plannerModel, {
  reasoning: "none",
  timeout: Duration.seconds(4),
  maxRetries: 0,
});

export const layerPlannerTextGeneration = layerPlanner.pipe(Layer.provide(layerProviderConfig));

export const layerModels = <E, R>(provider: Layer.Layer<AiProvider, E, R>, options: Partial<TextOptions> = {}) =>
  Layer.merge(layerTextGeneration(Models.summaryModel, options), layerEmbeddings(Models.embeddingModel)).pipe(
    Layer.provide(provider),
  );

export const layer = layerModels(layerProviderConfig);

type ApiKey = Option.Option<Redacted.Redacted<string>>;

export const layerModelsForKey = (key: ApiKey, options: Partial<TextOptions> = {}) =>
  Option.match(key, {
    onNone: () => layerKeyMissing,
    onSome: (apiKey) => layerModels(layerProvider({ apiKey }), options),
  });

export const layerSearchForKey = (key: ApiKey) =>
  Option.match(key, {
    onNone: () => Layer.merge(keyMissingText(Models.plannerModel), keyMissingEmbeddings(Models.embeddingModel)),
    onSome: (apiKey) =>
      Layer.merge(layerPlanner, layerEmbeddings(Models.embeddingModel)).pipe(Layer.provide(layerProvider({ apiKey }))),
  });
