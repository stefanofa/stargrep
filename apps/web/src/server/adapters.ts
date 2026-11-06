import { SyncLimiter, SyncLimiterUnavailable, SyncRateLimited } from "@stargrep/api/sync-limiter";
import { SearchCache } from "@stargrep/core/search";
import { StarSync, SyncQueue } from "@stargrep/core/stars";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const kvMinimumTtl = Duration.seconds(60);

const expirationTtl = (ttl: Duration.Duration) => Math.ceil(Duration.toSeconds(Duration.max(ttl, kvMinimumTtl)));

export const layerSearchCache = (namespace: KVNamespace) =>
  Layer.effect(
    SearchCache.SearchCache,
    SearchCache.make({
      get: (key) =>
        Effect.tryPromise({
          try: () => namespace.get(key),
          catch: (cause) => new SearchCache.SearchCacheFailed({ operation: "get", cause }),
        }).pipe(Effect.map(Option.fromNullishOr)),
      set: (key, value, ttl) =>
        Effect.tryPromise({
          try: () => namespace.put(key, value, { expirationTtl: expirationTtl(ttl) }),
          catch: (cause) => new SearchCache.SearchCacheFailed({ operation: "set", cause }),
        }),
    }),
  ).pipe(Layer.provide(Digest.layerWebCrypto));

const encodeSyncRequest = Schema.encodeSync(StarSync.LoginSyncRequest);

export const layerSyncQueue = (queue: Queue<unknown>) =>
  Layer.succeed(
    SyncQueue.SyncQueue,
    SyncQueue.SyncQueue.of({
      send: Effect.fn("SyncQueue.send")(function* (request: StarSync.LoginSyncRequest, delay: Duration.Duration) {
        yield* Effect.tryPromise({
          try: () => queue.send(encodeSyncRequest(request), { delaySeconds: Math.ceil(Duration.toSeconds(delay)) }),
          catch: (cause) => new SyncQueue.SyncQueueFailed({ cause }),
        });
      }),
    }),
  );

interface SyncLimits {
  readonly perCaller: RateLimit;
  readonly overall: RateLimit;
}

const withinLimit = (limit: RateLimit, key: string, name: SyncRateLimited["limit"]) =>
  Effect.tryPromise({
    try: () => limit.limit({ key }),
    catch: (cause) => new SyncLimiterUnavailable({ cause }),
  }).pipe(Effect.flatMap(({ success }) => (success ? Effect.void : Effect.fail(new SyncRateLimited({ limit: name })))));

export const layerSyncLimiter = (limits: SyncLimits, caller: string) =>
  Layer.succeed(
    SyncLimiter,
    SyncLimiter.of({
      acquire: withinLimit(limits.perCaller, caller, "caller").pipe(
        Effect.andThen(withinLimit(limits.overall, "all", "overall")),
        Effect.withSpan("SyncLimiter.acquire"),
      ),
    }),
  );
