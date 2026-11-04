import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Embedding, EmbeddingModelId, embeddingDimensions, Float32Vector, requireModel } from "../src/embedding.ts";

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

it.effect("decodes a base64 vector only when it holds exactly one float32 per dimension", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(Float32Vector);
    const base64 = (bytes: number) => Buffer.from(new Uint8Array(bytes)).toString("base64");
    expect((yield* decode(base64(embeddingDimensions * 4))).length).toBe(embeddingDimensions);
    for (const bytes of [1, 2, 3, embeddingDimensions * 2, embeddingDimensions * 4 + 4]) {
      expect([bytes, (yield* Effect.flip(decode(base64(bytes))))._tag]).toEqual([bytes, "SchemaError"]);
    }
  }),
);
