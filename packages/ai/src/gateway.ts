import { createGateway, GatewayError, GatewayModelNotFoundError, type GatewayProvider } from "@ai-sdk/gateway";
import {
  APICallError,
  embedMany,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type EmbeddingModel as SdkEmbeddingModel,
  type LanguageModel as SdkLanguageModel,
} from "ai";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
import { noRetry, type Retry, unavailableRetry } from "./port.ts";
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

const fromSdkError = (operation: Operation, model: string) => (cause: unknown) => {
  if (GatewayModelNotFoundError.isInstance(cause)) return new AiModelNotFound({ model });
  if (NoObjectGeneratedError.isInstance(cause))
    return new AiOutputInvalid({ operation, model, detail: "the model did not return a JSON object" });
  if (isRetryable(cause)) return new AiUnavailable({ operation, model, detail: detailOf(cause) });
  return new AiRequestFailed({ operation, model, detail: detailOf(cause) });
};

const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Json);
const encodeJson = Schema.encodeUnknownEffect(Json);

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

// The Gateway replays a batch start that repeats an idempotency key with the same body, so a run that
// dies while it waits finds its batch again instead of paying for it twice.
const idempotencyKey = (model: string, request: TextGeneration.RunBatchRequest) =>
  encodeJson([model, request.system, request.jsonSchema, request.prompts]).pipe(
    Effect.orDie,
    Effect.flatMap((text) => Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))),
    Effect.map((digest) => `stargrep-batch-${toHex(digest)}`),
  );

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

const runBatch = (provider: AiProvider["Service"], model: string) =>
  Effect.fn("Gateway.runBatch")(function* (request: TextGeneration.RunBatchRequest) {
    const api = provider.experimental_batch();
    const call = <A>(run: (abortSignal: AbortSignal) => PromiseLike<A>) =>
      Effect.tryPromise({ try: run, catch: fromSdkError("generate", model) }).pipe(Effect.retry(unavailableRetry));
    const key = yield* idempotencyKey(model, request);
    const started = yield* call((abortSignal) =>
      api.doStartBatch({
        requests: request.prompts.map((prompt, index) => ({
          id: String(index),
          type: "text" as const,
          modelId: model,
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
    const finished =
      started.status !== "pending"
        ? started
        : yield* call((abortSignal) => api.doGetBatchStatus({ batchId: started.batchId, abortSignal })).pipe(
            Effect.repeat({
              schedule: Schedule.spaced(batchPollInterval),
              until: (status) => status.status !== "pending",
            }),
          );
    yield* Effect.logInfo("Gateway batch finished", {
      batchId: started.batchId,
      status: finished.rawStatus ?? finished.status,
      completed: finished.requestCounts?.completed ?? null,
      failed: finished.requestCounts?.failed ?? null,
    });
    if (finished.status === "failed") {
      const code = finished.error?.code ?? finished.error?.type ?? "no code";
      return yield* new AiRequestFailed({ operation: "generate", model, detail: `batch failed with ${code}` });
    }
    const items = yield* call(async (abortSignal) => {
      const reader = (await api.doGetBatchResults({ batchId: started.batchId, abortSignal })).getReader();
      const read: Array<BatchItem> = [];
      for (let next = await reader.read(); !next.done; next = await reader.read()) read.push(next.value);
      return read;
    });
    const byId = new Map<string, BatchItem>(items.map((item) => [item.id, item]));
    return yield* Effect.forEach(request.prompts, (_, index) => {
      const item = byId.get(String(index));
      return item === undefined ? Effect.undefined : Effect.result(batchItemResult(model, item));
    });
  });

export interface TextOptions {
  readonly reasoning: "none" | "provider-default";
  readonly timeout: Duration.Duration;
  readonly retry: Retry;
  readonly batch: boolean;
}

const defaultTextOptions: TextOptions = {
  reasoning: "provider-default",
  timeout: textTimeout,
  retry: unavailableRetry,
  batch: true,
};

export const layerTextGeneration = (model: string, options: Partial<TextOptions> = {}) => {
  const { reasoning, timeout, retry, batch } = { ...defaultTextOptions, ...options };
  return Layer.effect(
    TextGeneration.TextGeneration,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) =>
        TextGeneration.make({
          provider: "gateway",
          model,
          timeout,
          retry,
          run: (request) =>
            Effect.tryPromise({
              try: (abortSignal) =>
                generateText({
                  model: provider.languageModel(model),
                  output: Output.object({ schema: jsonSchema(request.jsonSchema) }),
                  system: request.system,
                  prompt: request.prompt,
                  maxRetries: 0,
                  abortSignal,
                  reasoning,
                }),
              catch: fromSdkError("generate", model),
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
              })),
            ),
          ...(batch ? { batch: { timeout: batchTimeout, run: runBatch(provider, model) } } : {}),
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
                  maxRetries: 0,
                  abortSignal,
                }),
              catch: fromSdkError("embed", model.id),
            }).pipe(Effect.map((result) => ({ vectors: result.embeddings, tokens: result.usage.tokens }))),
        }),
      ),
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

export const layerProviderConfig = Layer.unwrap(
  Config.Redacted("AI_GATEWAY_API_KEY").pipe(Effect.map((apiKey) => layerProvider({ apiKey }))),
);

export const layerPlannerTextGeneration = layerTextGeneration(Models.plannerModel, {
  reasoning: "none",
  timeout: Duration.seconds(4),
  retry: noRetry,
}).pipe(Layer.provide(layerProviderConfig));

export const layerModels = <E, R>(provider: Layer.Layer<AiProvider, E, R>, options: Partial<TextOptions> = {}) =>
  Layer.merge(layerTextGeneration(Models.summaryModel, options), layerEmbeddings(Models.embeddingModel)).pipe(
    Layer.provide(provider),
  );

export const layer = layerModels(layerProviderConfig);
