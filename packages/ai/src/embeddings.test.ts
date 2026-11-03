import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Embeddings from "./embeddings.ts";

const model = { id: "seam/embed", dimensions: 3 };

const service = (vectors: ReadonlyArray<ReadonlyArray<number>>) =>
  Embeddings.make({
    provider: "test",
    model,
    timeout: Duration.seconds(5),
    run: () => Effect.succeed({ vectors, tokens: 4 }),
  });

describe("Embeddings.make", () => {
  it.effect("tags each vector with the model that made it", () =>
    Effect.gen(function* () {
      const embeddings = yield* service([[1, 0, 0]]).embed(["one"]);
      expect(embeddings).toEqual([{ model: "seam/embed", vector: [1, 0, 0] }]);
    }),
  );

  it.effect("fails with AiOutputInvalid when a vector has the wrong size", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(service([[1, 0]]).embed(["one"]));
      expect(error.message).toBe(
        "Model 'seam/embed' returned output that does not match the expected shape in 'embed': expected 1 vectors of 3 dimensions, got 1 with 2",
      );
    }),
  );

  it.effect("fails with AiOutputInvalid when the vector count differs from the input", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(service([[1, 0, 0]]).embed(["one", "two"])))._tag).toBe("AiOutputInvalid");
    }),
  );
});
