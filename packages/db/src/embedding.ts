import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

export const Float32Vector = Schema.Uint8ArrayFromBase64.pipe(
  Schema.check(
    Schema.makeFilter((bytes: Uint8Array) =>
      bytes.length === embeddingDimensions * 4
        ? undefined
        : `expected ${embeddingDimensions * 4} bytes of float32, got ${bytes.length}`,
    ),
  ),
  Schema.decodeTo(
    Schema.Array(Schema.Finite),
    SchemaTransformation.transform<ReadonlyArray<number>, Uint8Array>({
      decode: (bytes) => Array.from(new Float32Array(bytes.slice().buffer)),
      encode: (vector) => new Uint8Array(Float32Array.from(vector).buffer),
    }),
  ),
);

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

export class EmbeddingModelConflict extends Schema.TaggedError<
  EmbeddingModelConflict,
  { readonly brand: unique symbol }
>()("EmbeddingModelConflict", {
  stored: EmbeddingModelId,
  storedDimensions: Schema.Int,
  configured: EmbeddingModelId,
  configuredDimensions: Schema.Int,
}) {
  override get message(): string {
    return `The database holds '${this.stored}' embeddings with ${this.storedDimensions} dimensions, and this process is configured for '${this.configured}' with ${this.configuredDimensions}`;
  }
}
