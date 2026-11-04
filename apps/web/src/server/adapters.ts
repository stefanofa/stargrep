import { SyncLimiter } from "@stargrep/api/sync-limiter";
import { SearchCache } from "@stargrep/core/search";
import { type StarSync, SyncQueue, SyncRequestLog } from "@stargrep/core/stars";
import type { Login } from "@stargrep/github/schemas";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const kvMinimumTtl = Duration.seconds(60);

export const expirationTtl = (ttl: Duration.Duration) => Math.ceil(Duration.toSeconds(Duration.max(ttl, kvMinimumTtl)));

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

const decodeTime = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString);

export const layerSyncRequestLog = (namespace: KVNamespace) =>
  Layer.succeed(
    SyncRequestLog.SyncRequestLog,
    SyncRequestLog.SyncRequestLog.of({
      lastRequest: Effect.fn("SyncRequestLog.lastRequest")(function* (login: Login) {
        const stored = yield* Effect.tryPromise({
          try: () => namespace.get(login),
          catch: (cause) => new SyncRequestLog.SyncRequestLogFailed({ operation: "read", cause }),
        });
        return stored === null ? Option.none() : yield* Effect.option(decodeTime(stored));
      }),
      record: Effect.fn("SyncRequestLog.record")(function* (
        login: Login,
        at: DateTime.Utc,
        lifetime: Duration.Duration,
      ) {
        yield* Effect.tryPromise({
          try: () => namespace.put(login, DateTime.formatIso(at), { expirationTtl: expirationTtl(lifetime) }),
          catch: (cause) => new SyncRequestLog.SyncRequestLogFailed({ operation: "write", cause }),
        });
      }),
    }),
  );

export const layerSyncQueue = (queue: Queue<unknown>) =>
  Layer.succeed(
    SyncQueue.SyncQueue,
    SyncQueue.SyncQueue.of({
      send: Effect.fn("SyncQueue.send")(function* (request: StarSync.LoginSyncRequest) {
        yield* Effect.tryPromise({
          try: () => queue.send(request),
          catch: (cause) => new SyncQueue.SyncQueueFailed({ cause }),
        });
      }),
    }),
  );

export interface SyncLimits {
  readonly perCaller: RateLimit;
  readonly overall: RateLimit;
}

const within = (limit: RateLimit, key: string) =>
  Effect.tryPromise(() => limit.limit({ key })).pipe(Effect.map((outcome) => outcome.success));

export const layerSyncLimiter = (limits: SyncLimits, caller: string) =>
  Layer.succeed(
    SyncLimiter,
    SyncLimiter.of({
      allow: within(limits.perCaller, caller).pipe(
        Effect.flatMap((allowed) => (allowed ? within(limits.overall, "all") : Effect.succeed(false))),
        Effect.catchTags({
          UnknownError: () => Effect.logWarning("Sync rate limit check failed").pipe(Effect.as(false)),
        }),
        Effect.withSpan("SyncLimiter.allow"),
      ),
    }),
  );
