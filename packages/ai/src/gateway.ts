import { createGateway, GatewayModelNotFoundError } from "@ai-sdk/gateway";
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
import * as Embeddings from "./embeddings.ts";
import { AiModelNotFound, AiOutputInvalid, AiRequestFailed, type Operation } from "./errors.ts";
import * as Models from "./models.ts";
import * as TextGeneration from "./text-generation.ts";

export class AiProvider extends Context.Service<
  AiProvider,
  {
    readonly languageModel: (modelId: string) => SdkLanguageModel;
    readonly embeddingModel: (modelId: string) => SdkEmbeddingModel;
  }
>()("@stargrep/ai/gateway/AiProvider") {}

const silenceSdkWarnings = () => {
  globalThis.AI_SDK_LOG_WARNINGS = false;
};

const detailOf = (cause: unknown) => {
  if (APICallError.isInstance(cause)) return `${cause.name} with status ${cause.statusCode ?? "none"}`;
  return cause instanceof Error ? cause.name : "unknown error";
};

const fromSdkError = (operation: Operation, model: string) => (cause: unknown) => {
  if (GatewayModelNotFoundError.isInstance(cause)) return new AiModelNotFound({ model });
  if (NoObjectGeneratedError.isInstance(cause))
    return new AiOutputInvalid({ operation, model, detail: "the model did not return a JSON object" });
  return new AiRequestFailed({ operation, model, detail: detailOf(cause) });
};

export const layerTextGeneration = (model: string) =>
  Layer.effect(
    TextGeneration.TextGeneration,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) =>
        TextGeneration.make({
          provider: "gateway",
          model,
          timeout: Duration.seconds(60),
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
                }),
              catch: fromSdkError("generate", model),
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
              })),
            ),
        }),
      ),
    ),
  );

export const layerEmbeddings = (model: Models.EmbeddingModel) =>
  Layer.effect(
    Embeddings.Embeddings,
    Effect.andThen(
      Effect.sync(silenceSdkWarnings),
      AiProvider.useSync((provider) =>
        Embeddings.make({
          provider: "gateway",
          model,
          timeout: Duration.seconds(30),
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

export const layerProvider = (config: { readonly apiKey: Redacted.Redacted<string> }) =>
  Layer.sync(AiProvider, () => AiProvider.of(createGateway({ apiKey: Redacted.value(config.apiKey) })));

export const layerProviderConfig = Layer.unwrap(
  Config.Redacted("AI_GATEWAY_API_KEY").pipe(Effect.map((apiKey) => layerProvider({ apiKey }))),
);

export const layer = Layer.merge(layerTextGeneration(Models.summaryModel), layerEmbeddings(Models.embeddingModel)).pipe(
  Layer.provide(layerProviderConfig),
);
