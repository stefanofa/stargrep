import { SyncRequestLog } from "@stargrep/core/stars";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const kvMinimumTtl = Duration.seconds(60);

export const expirationTtl = (ttl: Duration.Duration) => Math.ceil(Duration.toSeconds(Duration.max(ttl, kvMinimumTtl)));

export interface KvStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (key: string, value: string, options: { readonly expirationTtl: number }) => Promise<void>;
}

export const layerSyncRequestLog = (namespace: KvStore) =>
  Layer.succeed(
    SyncRequestLog.SyncRequestLog,
    SyncRequestLog.make({
      get: (key) =>
        Effect.tryPromise({
          try: () => namespace.get(key),
          catch: (cause) => new SyncRequestLog.SyncRequestLogFailed({ operation: "read", cause }),
        }).pipe(Effect.map(Option.fromNullishOr)),
      put: (key, value, ttl) =>
        Effect.tryPromise({
          try: () => namespace.put(key, value, { expirationTtl: expirationTtl(ttl) }),
          catch: (cause) => new SyncRequestLog.SyncRequestLogFailed({ operation: "write", cause }),
        }),
    }),
  );
