import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Embeddings from "@stargrep/ai/embeddings";
import type * as TextGeneration from "@stargrep/ai/text-generation";
import { BlobStore, EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import * as GitHub from "@stargrep/github/github";
import type * as TokenGate from "@stargrep/github/token-gate";
import * as AiRuntime from "@stargrep/runtime/ai";
import * as DbRuntime from "@stargrep/runtime/db";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Ref from "effect/Ref";

const queueBatchLimit = 100;
// A Worker invocation holds at most six connections, and R2 and the queue need some of them.
const maxDatabaseConnections = 4;

export const inRuntime = Effect.map(
  Effect.service(RuntimeContext),
  (context) =>
    <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
      Effect.provideService(effect, RuntimeContext, context),
);

export const layerBlobStore = (bucket: Cloudflare.R2.ReadWriteBucketClient) =>
  Layer.effect(
    BlobStore.BlobStore,
    Effect.gen(function* () {
      const run = yield* inRuntime;
      return BlobStore.BlobStore.of({
        get: Effect.fn("BlobStore.get")(
          function* (key: string) {
            const object = yield* run(bucket.get(key));
            return object === null ? Option.none() : Option.some(yield* object.text());
          },
          (effect, key) =>
            Effect.mapError(effect, (cause) => new BlobStore.BlobStoreFailed({ operation: "get", key, cause })),
        ),
        put: Effect.fn("BlobStore.put")(
          function* (key: string, value: string) {
            yield* run(bucket.put(key, value));
          },
          (effect, key) =>
            Effect.mapError(effect, (cause) => new BlobStore.BlobStoreFailed({ operation: "put", key, cause })),
        ),
      });
    }),
  );

export const layerEnrichQueue = (queue: Cloudflare.Queues.WriteQueueClient) =>
  Layer.effect(
    EnrichQueue.EnrichQueue,
    Effect.gen(function* () {
      const run = yield* inRuntime;
      return EnrichQueue.EnrichQueue.of({
        send: Effect.fn("EnrichQueue.send")(
          function* (messages: ReadonlyArray<EnrichQueue.EnrichRepo>) {
            for (const chunk of Arr.chunksOf(messages, queueBatchLimit)) {
              yield* run(queue.sendBatch(chunk.map((body) => ({ body }))));
            }
          },
          (effect, messages) =>
            Effect.mapError(effect, (cause) => new EnrichQueue.EnrichQueueFailed({ messages: messages.length, cause })),
        ),
      });
    }),
  );

export const aiModels = Effect.map(AiRuntime.aiGatewayKey, AiRuntime.layerSummaries);

interface Bindings {
  readonly database: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  readonly readmes: Cloudflare.R2.ReadWriteBucketClient;
  readonly enrichQueue: Cloudflare.Queues.WriteQueueClient;
  readonly tokenGate: Layer.Layer<TokenGate.TokenGate, never, RuntimeContext>;
  readonly ai: Layer.Layer<TextGeneration.TextGeneration | Embeddings.Embeddings>;
  readonly adopted: Ref.Ref<boolean>;
}

// Built again for every invocation, because a socket opened in one request cannot serve another.
export const layerRuntime = (bindings: Bindings) =>
  Layer.empty.pipe(
    Layer.provideMerge(Layer.merge(StarSync.layer, EnrichRepo.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        GitHub.layer.pipe(Layer.provide(bindings.tokenGate)),
        layerBlobStore(bindings.readmes),
        layerEnrichQueue(bindings.enrichQueue),
      ),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(bindings.database, (connectionString) =>
          DbRuntime.layerDb({ connectionString, adopted: bindings.adopted, maxConnections: maxDatabaseConnections }),
        ),
      ),
    ),
    Layer.provideMerge(bindings.ai),
  );
