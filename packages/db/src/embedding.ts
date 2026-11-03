import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const embeddingDimensions = 1024;

export const EmbeddingModelId = Schema.NonEmptyString.pipe(Schema.brand("EmbeddingModelId"));
export type EmbeddingModelId = typeof EmbeddingModelId.Type;

export const EmbeddingVector = Schema.Array(Schema.Finite).pipe(
  Schema.check(Schema.isBetweenLength(embeddingDimensions, embeddingDimensions)),
  Schema.brand("EmbeddingVector"),
);
export type EmbeddingVector = typeof EmbeddingVector.Type;

export const Embedding = Schema.Struct({ model: EmbeddingModelId, vector: EmbeddingVector });
export type Embedding = typeof Embedding.Type;

export class EmbeddingModelMismatch extends Schema.TaggedError<
  EmbeddingModelMismatch,
  { readonly brand: unique symbol }
>()("EmbeddingModelMismatch", {
  expected: EmbeddingModelId,
  received: EmbeddingModelId,
}) {
  override get message(): string {
    return `The database holds '${this.expected}' embeddings and refuses a vector from '${this.received}'`;
  }
}

export const requireModel = (
  configured: EmbeddingModelId,
  embedding: Embedding,
): Effect.Effect<EmbeddingVector, EmbeddingModelMismatch> =>
  embedding.model === configured
    ? Effect.succeed(embedding.vector)
    : Effect.fail(new EmbeddingModelMismatch({ expected: configured, received: embedding.model }));
