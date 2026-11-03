import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EmbeddingModelMismatch } from "./errors.ts";
import { EmbeddingModel } from "./ids.ts";
import { embeddingDimensions } from "./schema.ts";

export const EmbeddingVector = Schema.Array(Schema.Finite).pipe(
  Schema.check(Schema.isBetweenLength(embeddingDimensions, embeddingDimensions)),
  Schema.brand("EmbeddingVector"),
);
export type EmbeddingVector = typeof EmbeddingVector.Type;

export const Embedding = Schema.Struct({ model: EmbeddingModel, vector: EmbeddingVector });
export type Embedding = typeof Embedding.Type;

export const requireModel = (
  configured: EmbeddingModel,
  embedding: Embedding,
): Effect.Effect<EmbeddingVector, EmbeddingModelMismatch> =>
  embedding.model === configured
    ? Effect.succeed(embedding.vector)
    : Effect.fail(new EmbeddingModelMismatch({ expected: configured, received: embedding.model }));
