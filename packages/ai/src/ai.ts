import { createGateway, GatewayModelNotFoundError } from "@ai-sdk/gateway";
import {
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
import * as Schema from "effect/Schema";
import type { EmbeddingModel } from "./models.ts";
import type { AiSchema } from "./schema-bridge.ts";

const Operation = Schema.Literals(["generate", "embed"]);

export class AiModelNotFound extends Schema.TaggedError<AiModelNotFound>()("AiModelNotFound", {
  model: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Model '${this.model}' is not available through the AI Gateway`;
  }
}

export class AiOutputInvalid extends Schema.TaggedError<AiOutputInvalid>()("AiOutputInvalid", {
  operation: Operation,
  model: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Model '${this.model}' returned output that does not match the expected shape in '${this.operation}'`;
  }
}

export class AiTimeout extends Schema.TaggedError<AiTimeout>()("AiTimeout", {
  operation: Operation,
  model: Schema.String,
  timeoutMillis: Schema.Finite,
}) {
  override get message(): string {
    return `Model '${this.model}' did not answer '${this.operation}' within ${this.timeoutMillis} ms`;
  }
}

export class AiRequestFailed extends Schema.TaggedError<AiRequestFailed>()("AiRequestFailed", {
  operation: Operation,
  model: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Model '${this.model}' request failed in '${this.operation}'`;
  }
}

export type AiError = AiModelNotFound | AiOutputInvalid | AiTimeout | AiRequestFailed;

export type Embedding = ReadonlyArray<number>;

export interface GenerateRequest<A> {
  readonly model: string;
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
}

export interface EmbedRequest {
  readonly model: EmbeddingModel;
  readonly values: ReadonlyArray<string>;
}

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
>()("@stargrep/ai/ai/AiProvider") {}

export class Ai extends Context.Service<
  Ai,
  {
    readonly generate: <A>(request: GenerateRequest<A>) => Effect.Effect<A, AiError>;
    readonly embed: (request: EmbedRequest) => Effect.Effect<ReadonlyArray<Embedding>, AiError>;
  }
>()("@stargrep/ai/ai") {}

type Operation = typeof Operation.Type;

const fromSdkError = (operation: Operation, model: string) => (cause: unknown) => {
  if (GatewayModelNotFoundError.isInstance(cause)) return new AiModelNotFound({ model, cause });
  if (NoObjectGeneratedError.isInstance(cause)) return new AiOutputInvalid({ operation, model, cause });
  return new AiRequestFailed({ operation, model, cause });
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

const make = Effect.gen(function* () {
  const provider = yield* AiProvider;

  const generate = <A>(request: GenerateRequest<A>): Effect.Effect<A, AiError> =>
    Effect.tryPromise({
      try: (abortSignal) =>
        generateText({
          model: provider.languageModel(request.model),
          output: Output.object({ schema: request.schema }),
          system: request.system,
          prompt: request.prompt,
          maxRetries: 0,
          abortSignal,
        }),
      catch: fromSdkError("generate", request.model),
    }).pipe(
      withTimeout("generate", request.model, generateTimeout),
      Effect.tap((result) =>
        Effect.all([
          countTokens(request.model, "input", result.usage.inputTokens),
          countTokens(request.model, "output", result.usage.outputTokens),
        ]),
      ),
      Effect.map((result) => result.output),
      Effect.withSpan("Ai.generate", { attributes: { model: request.model } }),
    );

  const embed = Effect.fn("Ai.embed")(function* (request: EmbedRequest) {
    const { id, dimensions } = request.model;
    const result = yield* Effect.tryPromise({
      try: (abortSignal) =>
        embedMany({
          model: provider.embeddingModel(id),
          values: [...request.values],
          dimensions,
          maxRetries: 0,
          abortSignal,
        }),
      catch: fromSdkError("embed", id),
    }).pipe(withTimeout("embed", id, embedTimeout));
    yield* countTokens(id, "input", result.usage.tokens);
    const wrongSize = result.embeddings.find((embedding) => embedding.length !== dimensions);
    if (result.embeddings.length !== request.values.length || wrongSize !== undefined) {
      return yield* new AiOutputInvalid({
        operation: "embed",
        model: id,
        cause: new Error(
          `expected ${request.values.length} vectors of ${dimensions} dimensions, got ${result.embeddings.length} with ${wrongSize?.length ?? dimensions}`,
        ),
      });
    }
    return result.embeddings;
  });

  return Ai.of({ generate, embed });
});

export const layer = Layer.effect(Ai, make);

export const layerGateway = (config: { readonly apiKey: Redacted.Redacted<string> }) =>
  layer.pipe(
    Layer.provide(
      Layer.sync(AiProvider, () => AiProvider.of(createGateway({ apiKey: Redacted.value(config.apiKey) }))),
    ),
  );
