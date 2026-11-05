import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Embeddings from "./embeddings.ts";
import type { EmbeddingModel } from "./models.ts";
import * as TextGeneration from "./text-generation.ts";

const timeout = Duration.seconds(5);

const words = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? []).filter((word) => word.length > 1);

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hashEmbedding = (text: string, dimensions: number): Array<number> => {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of words(text)) {
    const hash = fnv1a(word);
    vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + (hash & 0x80000000 ? -1 : 1);
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};

const tokens = (text: string) => Math.ceil(text.length / 4);

export const layerTextGeneration = (respond: (prompt: string) => unknown, model = "fake/text") =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({
      provider: "fake",
      model,
      timeout,
      run: (request) =>
        Effect.sync(() => ({
          output: respond(request.prompt),
          usage: { inputTokens: tokens(request.system + request.prompt), outputTokens: 0 },
        })),
    }),
  );

// Hash embeddings count shared words, so 0.5 keeps a repo whose words overlap the query's by about half or more.
export const hashEmbeddingModel: EmbeddingModel = {
  id: "fake/hash-embedding",
  dimensions: 1024,
  maxMatchDistance: 0.5,
};

export const layerEmbeddings = (model: EmbeddingModel = hashEmbeddingModel) =>
  Layer.succeed(
    Embeddings.Embeddings,
    Embeddings.make({
      provider: "fake",
      model,
      timeout,
      run: (values) =>
        Effect.succeed({
          vectors: values.map((value) => hashEmbedding(value, model.dimensions)),
          tokens: values.reduce((sum, value) => sum + tokens(value), 0),
        }),
    }),
  );
