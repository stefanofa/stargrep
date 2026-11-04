import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Embedding, EmbeddingModelId, embeddingDimensions, requireModel } from "../src/embedding.ts";

const database = Schema.decodeSync(EmbeddingModelId)("voyage/voyage-4");
const embedding = (model: string) =>
  Schema.decodeSync(Embedding)({ model, vector: new Array(embeddingDimensions).fill(0) });

it.effect("accepts a vector from the database's model", () =>
  Effect.gen(function* () {
    const vector = embedding("voyage/voyage-4");
    expect(yield* requireModel(database, vector)).toBe(vector.vector);
  }),
);

it.effect("refuses a vector from another model even when its size matches", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(requireModel(database, embedding("fake/hash-embedding")));
    expect(error).toMatchObject({
      _tag: "EmbeddingModelMismatch",
      expected: database,
      received: "fake/hash-embedding",
    });
  }),
);
