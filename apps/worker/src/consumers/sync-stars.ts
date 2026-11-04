import { StarSync } from "@stargrep/core/stars";
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
