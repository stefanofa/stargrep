import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Embeddings from "@stargrep/ai/embeddings";
import * as Gateway from "@stargrep/ai/gateway";
import type * as TextGeneration from "@stargrep/ai/text-generation";
import { FetchIcon, IconHttp, IconQueue, IconStore, Normalize } from "@stargrep/core/icons";
import { BlobStore, EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import * as GitHub from "@stargrep/github/github";
import type * as TokenGate from "@stargrep/github/token-gate";
import { aiGatewayKey } from "@stargrep/runtime/config";
import * as DbRuntime from "@stargrep/runtime/db";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Ref from "effect/Ref";
import { codecs } from "./icons/codecs.ts";

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

const sendBatches = (
  run: Effect.Success<typeof inRuntime>,
  queue: Cloudflare.Queues.WriteQueueClient,
  messages: ReadonlyArray<unknown>,
) =>
  Effect.forEach(
    Arr.chunksOf(messages, queueBatchLimit),
    (chunk) => run(queue.sendBatch(chunk.map((body) => ({ body })))),
    { discard: true },
  );

export const layerEnrichQueue = (queue: Cloudflare.Queues.WriteQueueClient) =>
  Layer.effect(
    EnrichQueue.EnrichQueue,
    Effect.map(inRuntime, (run) =>
      EnrichQueue.EnrichQueue.of({
        send: Effect.fn("EnrichQueue.send")(
          (messages: ReadonlyArray<EnrichQueue.EnrichRepo>) => sendBatches(run, queue, messages),
          (effect, messages) =>
            Effect.mapError(effect, (cause) => new EnrichQueue.EnrichQueueFailed({ messages: messages.length, cause })),
        ),
      }),
    ),
  );

export const layerIconQueue = (queue: Cloudflare.Queues.WriteQueueClient) =>
  Layer.effect(
    IconQueue.IconQueue,
    Effect.map(inRuntime, (run) =>
      IconQueue.IconQueue.of({
        send: Effect.fn("IconQueue.send")(
          (messages: ReadonlyArray<IconQueue.IconMessage>) => sendBatches(run, queue, messages),
          (effect, messages) =>
            Effect.mapError(effect, (cause) => new IconQueue.IconQueueFailed({ messages: messages.length, cause })),
        ),
      }),
    ),
  );

export const layerIconStore = (bucket: Cloudflare.R2.ReadWriteBucketClient) =>
  Layer.effect(
    IconStore.IconStore,
    Effect.gen(function* () {
      const run = yield* inRuntime;
      return IconStore.IconStore.of({
        head: Effect.fn("IconStore.head")(
          function* (key: string) {
            const object = yield* run(bucket.head(key));
            return Option.flatMap(Option.fromNullishOr(object), (found) =>
              IconStore.decodeMetadata(found.customMetadata),
            );
          },
          (effect, key) =>
            Effect.mapError(effect, (cause) => new IconStore.IconStoreFailed({ operation: "head", key, cause })),
        ),
        put: Effect.fn("IconStore.put")(
          function* (key: string, webp: Uint8Array, stored: IconStore.Stored) {
            yield* run(
              bucket.put(key, webp, {
                httpMetadata: { contentType: "image/webp", cacheControl: IconStore.cacheControl },
                customMetadata: IconStore.encodeMetadata(stored),
              }),
            );
          },
          (effect, key) =>
            Effect.mapError(effect, (cause) => new IconStore.IconStoreFailed({ operation: "put", key, cause })),
        ),
      });
    }),
  );

export const aiModels = Effect.map(aiGatewayKey, (key) => Gateway.layerModelsForKey(key, { batch: false }));

interface Bindings {
  readonly database: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  readonly readmes: Cloudflare.R2.ReadWriteBucketClient;
  readonly icons: Cloudflare.R2.ReadWriteBucketClient;
  readonly enrichQueue: Cloudflare.Queues.WriteQueueClient;
  readonly iconQueue: Cloudflare.Queues.WriteQueueClient;
  readonly tokenGate: Layer.Layer<TokenGate.TokenGate, never, RuntimeContext>;
  readonly ai: Layer.Layer<TextGeneration.TextGeneration | Embeddings.Embeddings>;
  readonly adopted: Ref.Ref<boolean>;
}

// Built again for every invocation, because a socket opened in one request cannot serve another.
export const layerRuntime = (bindings: Bindings) =>
  Layer.empty.pipe(
    Layer.provideMerge(Layer.mergeAll(EnrichRepo.layer, FetchIcon.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        GitHub.layer.pipe(Layer.provideMerge(bindings.tokenGate)),
        layerBlobStore(bindings.readmes),
        layerEnrichQueue(bindings.enrichQueue),
        layerIconQueue(bindings.iconQueue),
        layerIconStore(bindings.icons),
        IconHttp.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        Normalize.layer(codecs),
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
