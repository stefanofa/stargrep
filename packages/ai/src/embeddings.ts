import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import type { EmbeddingModel } from "./models.ts";
import { countTokens, portSpan } from "./text-generation.ts";

export interface Embedding {
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  readonly tokens: number | undefined;
}

export class Embeddings extends Context.Service<
  Embeddings,
  {
    readonly model: EmbeddingModel;
    readonly embed: (values: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Embedding>, AiError>;
  }
>()("@stargrep/ai/embeddings") {}

export const make = (options: {
  readonly provider: string;
  readonly model: EmbeddingModel;
  readonly timeout: Duration.Duration;
  readonly run: (values: ReadonlyArray<string>) => Effect.Effect<EmbedResult, AiError>;
}) => {
  const { provider, model, timeout, run } = options;
  const timedOut = new AiTimeout({ operation: "embed", model: model.id, timeoutMillis: Duration.toMillis(timeout) });
  const embed = Effect.fnUntraced(
    function* (values: ReadonlyArray<string>) {
      const { vectors, tokens } = yield* run(values).pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut) }),
      );
      yield* countTokens(model.id, "input", tokens);
      const wrongSize = vectors.find((vector) => vector.length !== model.dimensions);
      if (vectors.length !== values.length || wrongSize !== undefined) {
        return yield* new AiOutputInvalid({
          operation: "embed",
          model: model.id,
          detail: `expected ${values.length} vectors of ${model.dimensions} dimensions, got ${vectors.length} with ${wrongSize?.length ?? model.dimensions}`,
        });
      }
      return vectors.map((vector): Embedding => ({ model: model.id, vector }));
    },
    portSpan("Embeddings.embed", { provider, model: model.id }),
  );
  return Embeddings.of({ model, embed });
};

export class EmbeddingModelMismatch extends Schema.TaggedError<EmbeddingModelMismatch>()("EmbeddingModelMismatch", {
  expected: Schema.String,
  actual: Schema.String,
  dimensions: Schema.Finite,
}) {
  override get message(): string {
    return `Embedding from '${this.actual}' with ${this.dimensions} dimensions cannot be stored where the database uses '${this.expected}'`;
  }
}

export const requireModel =
  (expected: EmbeddingModel) =>
  (embedding: Embedding): Effect.Effect<Embedding, EmbeddingModelMismatch> =>
    embedding.model === expected.id && embedding.vector.length === expected.dimensions
      ? Effect.succeed(embedding)
      : Effect.fail(
          new EmbeddingModelMismatch({
            expected: expected.id,
            actual: embedding.model,
            dimensions: embedding.vector.length,
          }),
        );
