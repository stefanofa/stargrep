import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import { BlobStore, EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as GitHub from "@stargrep/github/github";
import * as TokenGate from "@stargrep/github/token-gate";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Ref from "effect/Ref";
import type { GitHubGate } from "./github-gate.ts";

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

type Gates = Effect.Success<typeof GitHubGate>;

const layerGate = (gates: Gates) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const run = yield* inRuntime;
      const gate = () => gates.getByName("github-token");
      return TokenGate.layerRemote({
        execute: (request) => run(gate().execute(request)),
        budget: Effect.suspend(() => gate().budget()),
      });
    }),
  );

export const layerGitHub = (gates: Option.Option<Gates>) =>
  GitHub.layer.pipe(Layer.provide(Option.match(gates, { onNone: () => TokenGate.layerMissing, onSome: layerGate })));

export const layerAi = (apiKey: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(apiKey, {
    onNone: () => Gateway.layerKeyMissing,
    onSome: (key) =>
      Layer.merge(
        Gateway.layerTextGeneration(Models.summaryModel),
        Gateway.layerEmbeddings(Models.embeddingModel),
      ).pipe(Layer.provide(Gateway.layerProvider({ apiKey: key }))),
  });

export interface Bindings {
  readonly database: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  readonly readmes: Cloudflare.R2.ReadWriteBucketClient;
  readonly enrichQueue: Cloudflare.Queues.WriteQueueClient;
  readonly gates: Option.Option<Gates>;
  readonly aiGatewayKey: Option.Option<Redacted.Redacted<string>>;
  readonly embeddingModel: EmbeddingModelId;
  readonly adopted: Ref.Ref<boolean>;
}

export const layerRuntime = (bindings: Bindings) =>
  Layer.empty.pipe(
    Layer.provideMerge(Layer.merge(StarSync.layer, EnrichRepo.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        layerGitHub(bindings.gates),
        layerBlobStore(bindings.readmes),
        layerEnrichQueue(bindings.enrichQueue),
        layerAi(bindings.aiGatewayKey),
      ),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(bindings.database, (connectionString) =>
          Db.layerNodePostgres({
            connectionString,
            embeddingModel: bindings.embeddingModel,
            adopted: bindings.adopted,
            maxConnections: maxDatabaseConnections,
          }),
        ),
      ),
    ),
  );
