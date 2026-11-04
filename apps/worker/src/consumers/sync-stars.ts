import { StarSync } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
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

export const markFailed =
  <E, R>(db: Layer.Layer<Db.Db, E, R>) =>
  (body: StarSync.SyncRequest | StarSync.LoginSyncRequest) =>
    "accountId" in body
      ? Effect.void
      : Db.Db.use((service) =>
          Effect.flatMap(DateTime.now, (now) => service.syncRequests.markFailed(body.login, now)),
        ).pipe(
          Effect.provide(db),
          Effect.catchCause(() => Effect.logWarning("Could not mark a dead-lettered sync as failed")),
        );
