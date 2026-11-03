import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AiError } from "./errors.ts";
import type { EmbeddingModel } from "./models.ts";

export interface Embedding {
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
}

export class Embeddings extends Context.Service<
  Embeddings,
  {
    readonly model: EmbeddingModel;
    readonly embed: (values: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Embedding>, AiError>;
  }
>()("@stargrep/ai/embeddings") {}

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
