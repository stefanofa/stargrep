import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { LoginSyncRequest } from "./star-sync.ts";

export class SyncQueueFailed extends Schema.TaggedError<SyncQueueFailed, { readonly brand: unique symbol }>()(
  "SyncQueueFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Sending a request to the sync queue failed";
  }
}

export class SyncQueue extends Context.Service<
  SyncQueue,
  {
    readonly send: (request: LoginSyncRequest) => Effect.Effect<void, SyncQueueFailed>;
  }
>()("@stargrep/core/stars/sync-queue/SyncQueue") {}

export const layerMemory = () => {
  const sent: Array<LoginSyncRequest> = [];
  const layer = Layer.succeed(
    SyncQueue,
    SyncQueue.of({
      send: Effect.fn("SyncQueue.send")(function* (request: LoginSyncRequest) {
        yield* Effect.sync(() => sent.push(request));
      }),
    }),
  );
  return { sent, layer };
};
