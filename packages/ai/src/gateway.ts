import { createGateway, GatewayModelNotFoundError } from "@ai-sdk/gateway";
import {
  APICallError,
  embedMany,
  generateText,
  NoObjectGeneratedError,
  Output,
  type EmbeddingModel as SdkEmbeddingModel,
  type LanguageModel as SdkLanguageModel,
} from "ai";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Embeddings from "./embeddings.ts";
import { AiModelNotFound, AiOutputInvalid, AiRequestFailed, AiTimeout, type Operation } from "./errors.ts";
import type { EmbeddingModel } from "./models.ts";
import * as TextGeneration from "./text-generation.ts";

const generateTimeout = Duration.seconds(60);
const embedTimeout = Duration.seconds(30);

export const tokensUsed = Metric.counter("stargrep_ai_tokens", {
  description: "Model tokens used, by model and direction.",
});

export class AiProvider extends Context.Service<
  AiProvider,
  {
    readonly languageModel: (modelId: string) => SdkLanguageModel;
    readonly embeddingModel: (modelId: string) => SdkEmbeddingModel;
  }
>()("@stargrep/ai/gateway/AiProvider") {}

const detailOf = (cause: unknown) => {
  if (APICallError.isInstance(cause)) return `${cause.name} with status ${cause.statusCode ?? "none"}`;
  return cause instanceof Error ? cause.name : "unknown error";
};

const fromSdkError = (operation: Operation, model: string) => (cause: unknown) => {
  if (GatewayModelNotFoundError.isInstance(cause)) return new AiModelNotFound({ model });
  if (NoObjectGeneratedError.isInstance(cause))
    return new AiOutputInvalid({ operation, model, detail: "structured output does not match the schema" });
  return new AiRequestFailed({ operation, model, detail: detailOf(cause) });
};

const withTimeout =
  (operation: Operation, model: string, timeout: Duration.Duration) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.timeoutOrElse(effect, {
      duration: timeout,
      orElse: () => Effect.fail(new AiTimeout({ operation, model, timeoutMillis: Duration.toMillis(timeout) })),
    });

const countTokens = (model: string, direction: "input" | "output", tokens: number | undefined) =>
  Metric.update(Metric.withAttributes(tokensUsed, { model, direction }), tokens ?? 0);

const makeTextGeneration = Effect.fn("Gateway.makeTextGeneration")(function* (model: string) {
  const provider = yield* AiProvider;
  const generate = <A>(request: TextGeneration.GenerateRequest<A>) =>
    Effect.tryPromise({
      try: (abortSignal) =>
        generateText({
          model: provider.languageModel(model),
          output: Output.object({ schema: request.schema }),
          system: request.system,
          prompt: request.prompt,
          maxRetries: 0,
          abortSignal,
        }),
      catch: fromSdkError("generate", model),
    }).pipe(
      withTimeout("generate", model, generateTimeout),
      Effect.tap((result) =>
        Effect.all([
          countTokens(model, "input", result.usage.inputTokens),
          countTokens(model, "output", result.usage.outputTokens),
        ]),
      ),
      Effect.map((result) => result.output),
      Effect.withSpan("TextGeneration.generate", { attributes: { provider: "gateway", model } }),
    );
  return TextGeneration.TextGeneration.of({ model, generate });
});

const makeEmbeddings = Effect.fn("Gateway.makeEmbeddings")(function* (model: EmbeddingModel) {
  const provider = yield* AiProvider;
  const embed = Effect.fn("Embeddings.embed")(function* (values: ReadonlyArray<string>) {
    const result = yield* Effect.tryPromise({
      try: (abortSignal) =>
        embedMany({
          model: provider.embeddingModel(model.id),
          values: [...values],
          dimensions: model.dimensions,
          maxRetries: 0,
          abortSignal,
        }),
      catch: fromSdkError("embed", model.id),
    }).pipe(withTimeout("embed", model.id, embedTimeout));
    yield* countTokens(model.id, "input", result.usage.tokens);
    const wrongSize = result.embeddings.find((embedding) => embedding.length !== model.dimensions);
    if (result.embeddings.length !== values.length || wrongSize !== undefined) {
      return yield* new AiOutputInvalid({
        operation: "embed",
        model: model.id,
        detail: `expected ${values.length} vectors of ${model.dimensions} dimensions, got ${result.embeddings.length} with ${wrongSize?.length ?? model.dimensions}`,
      });
    }
    return result.embeddings.map((vector): Embeddings.Embedding => ({ model: model.id, vector }));
  });
  return Embeddings.Embeddings.of({ model, embed });
});

export const layerTextGeneration = (model: string) =>
  Layer.effect(TextGeneration.TextGeneration, makeTextGeneration(model));

export const layerEmbeddings = (model: EmbeddingModel) => Layer.effect(Embeddings.Embeddings, makeEmbeddings(model));

export const layerProvider = (config: { readonly apiKey: Redacted.Redacted<string> }) =>
  Layer.sync(AiProvider, () => AiProvider.of(createGateway({ apiKey: Redacted.value(config.apiKey) })));
