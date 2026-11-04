import { StarSync, SyncRequestLog } from "@stargrep/core/stars";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Settle from "./settle.ts";

export const pipeline = Settle.pipeline({
  schema: Schema.Union([StarSync.SyncRequest, StarSync.LoginSyncRequest]),
  run: Effect.fn("SyncStarsConsumer.run")(function* (bodies) {
    const starSync = yield* StarSync.StarSync;
    return yield* Effect.forEach(bodies, (request) =>
      ("accountId" in request ? starSync.sync(request) : starSync.syncLogin(request)).pipe(
        Effect.as(Settle.Settlement.Done()),
        Effect.result,
      ),
    );
  }),
  describe: (body) =>
    "accountId" in body ? { accountId: body.accountId, mode: body.mode } : { login: body.login, mode: body.mode },
});

export const markFailed = Effect.fn("SyncStarsConsumer.markFailed")(function* (
  body: StarSync.SyncRequest | StarSync.LoginSyncRequest,
) {
  if ("accountId" in body) return;
  yield* (yield* SyncRequestLog.SyncRequestLog).markFailed(body.login).pipe(
    Effect.catchTags({
      SyncRequestLogFailed: (error) =>
        Effect.logWarning("Sync request log failed to record a dead letter", { operation: error.operation }),
    }),
  );
});
