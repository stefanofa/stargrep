import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
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

export class SyncRequestLog extends Context.Service<
  SyncRequestLog,
  {
    readonly lastRequest: (login: Login) => Effect.Effect<Option.Option<DateTime.Utc>, SyncRequestLogFailed>;
    readonly record: (
      login: Login,
      at: DateTime.Utc,
      lifetime: Duration.Duration,
    ) => Effect.Effect<void, SyncRequestLogFailed>;
  }
>()("@stargrep/core/stars/sync-request-log/SyncRequestLog") {}

export const layerMemory = () => {
  const requests = new Map<Login, DateTime.Utc>();
  const layer = Layer.succeed(
    SyncRequestLog,
    SyncRequestLog.of({
      lastRequest: Effect.fn("SyncRequestLog.lastRequest")(function* (login: Login) {
        return yield* Effect.sync(() => Option.fromUndefinedOr(requests.get(login)));
      }),
      record: Effect.fn("SyncRequestLog.record")(function* (login: Login, at: DateTime.Utc) {
        yield* Effect.sync(() => requests.set(login, at));
      }),
    }),
  );
  return { requests, layer };
};
