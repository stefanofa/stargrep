import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class SyncRequestLogFailed extends Schema.TaggedError<SyncRequestLogFailed, { readonly brand: unique symbol }>()(
  "SyncRequestLogFailed",
  {
    operation: Schema.Literals(["read", "write"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sync request log '${this.operation}' failed`;
  }
}

export const SyncRequest = Schema.Struct({
  requestedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.Literals(["pending", "failed"]),
});
export type SyncRequest = typeof SyncRequest.Type;

export const requestLifetime = Duration.days(1);

export interface Backend {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, SyncRequestLogFailed>;
  readonly put: (key: string, value: string, ttl: Duration.Duration) => Effect.Effect<void, SyncRequestLogFailed>;
}

export class SyncRequestLog extends Context.Service<
  SyncRequestLog,
  {
    readonly lastRequest: (login: Login) => Effect.Effect<Option.Option<SyncRequest>, SyncRequestLogFailed>;
    readonly markPending: (login: Login, at: DateTime.Utc) => Effect.Effect<void, SyncRequestLogFailed>;
    readonly markFailed: (login: Login) => Effect.Effect<void, SyncRequestLogFailed>;
  }
>()("@stargrep/core/stars/sync-request-log/SyncRequestLog") {}

const Stored = Schema.fromJsonString(SyncRequest);
const decodeStored = Schema.decodeUnknownEffect(Stored);
const encodeStored = Schema.encodeEffect(Stored);

export const make = (backend: Backend) => {
  const keyOf = (login: Login) => login.toLowerCase();

  const lastRequest = Effect.fn("SyncRequestLog.lastRequest")(function* (login: Login) {
    const stored = yield* backend.get(keyOf(login));
    if (Option.isNone(stored)) return Option.none<SyncRequest>();
    return yield* decodeStored(stored.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: () =>
          Effect.logWarning("Sync request log entry does not decode").pipe(Effect.as(Option.none<SyncRequest>())),
      }),
    );
  });

  const store = (login: Login, request: SyncRequest) =>
    encodeStored(request).pipe(
      Effect.orDie,
      Effect.flatMap((value) => backend.put(keyOf(login), value, requestLifetime)),
    );

  const markPending = Effect.fn("SyncRequestLog.markPending")(function* (login: Login, at: DateTime.Utc) {
    yield* store(login, { requestedAt: at, outcome: "pending" });
  });

  const markFailed = Effect.fn("SyncRequestLog.markFailed")(function* (login: Login) {
    const previous = yield* lastRequest(login);
    const requestedAt = Option.isSome(previous) ? previous.value.requestedAt : yield* DateTime.now;
    yield* store(login, { requestedAt, outcome: "failed" });
  });

  return SyncRequestLog.of({ lastRequest, markPending, markFailed });
};

export const layerMemory = () => {
  const stored = new Map<string, string>();
  const layer = Layer.succeed(
    SyncRequestLog,
    make({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(stored.get(key))),
      put: (key, value) => Effect.sync(() => void stored.set(key, value)),
    }),
  );
  return { stored, layer };
};
