import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Batches from "./batches.ts";
import * as Embeddings from "./embeddings.ts";
import type { AiError } from "./errors.ts";
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

export interface Submission {
  readonly key: string;
  readonly batchId: string;
  // True when the key matched a batch an earlier submit started, so nothing new was paid for.
  readonly replayed: boolean;
}

// A provider batch API that answers every prompt with respond, and like the Gateway replays a submit whose idempotency
// key it has seen: the same batch ID and the answers stored when that batch was first paid for. submissions records
// every submit, and paid every prompt answered, so a test can count what a run would have paid. collecting, when set,
// may answer a collect in place of the stored batch, so a test can make the provider fail, forget, or stall; returning
// undefined collects the stored batch. forgetKeys makes the provider forget every idempotency key while it keeps every
// batch by ID.
export const batches = (respond: (prompt: string) => unknown, model = "fake/text") => {
  const submissions: Array<Submission> = [];
  const paid: Array<string> = [];
  const started = new Map<string, string>();
  const byId = new Map<string, Batches.BatchItems>();
  const control: {
    collecting: ((batchId: string) => Effect.Effect<Batches.Collected, AiError> | undefined) | undefined;
  } = { collecting: undefined };
  const layer = Layer.succeed(
    Batches.Batches,
    Batches.Batches.of({
      provider: "fake",
      model,
      submit: Effect.fn("FakeBatches.submit")(function* (request: Batches.BatchRequest) {
        const key = yield* Batches.requestKey(request);
        const known = started.get(key);
        if (known !== undefined) {
          submissions.push({ key, batchId: known, replayed: true });
          return known;
        }
        const batchId = `fake_batch_${byId.size + 1}`;
        const items = request.prompts.map((prompt) => {
          paid.push(prompt);
          return Result.succeed({
            output: respond(prompt),
            usage: { inputTokens: tokens(request.system + prompt), outputTokens: 0, reasoningTokens: 0 },
          });
        });
        started.set(key, batchId);
        byId.set(batchId, items);
        submissions.push({ key, batchId, replayed: false });
        return batchId;
      }),
      collect: Effect.fn("FakeBatches.collect")(function* (batchId: string, size: number) {
        const instead = control.collecting?.(batchId);
        if (instead !== undefined) return yield* instead;
        const items = byId.get(batchId);
        if (items === undefined) return Batches.Collected.Unknown({ batchId });
        return Batches.Collected.Answered({ items: Array.from({ length: size }, (_, index) => items[index]) });
      }),
    }),
  );
  const forgetKeys = () => started.clear();
  return { layer, submissions, paid, control, forgetKeys };
};

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
