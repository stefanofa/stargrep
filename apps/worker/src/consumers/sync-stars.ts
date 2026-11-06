import { StarSync, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Settle from "./settle.ts";

const markFailed = Effect.fn("SyncStarsConsumer.markFailed")(function* (
  body: StarSync.SyncRequest | StarSync.LoginSyncRequest,
) {
  if ("accountId" in body || body.requestedAt === undefined) return;
  const db = yield* Db.Db;
  yield* db.syncRequests
    .settle(body.login, body.requestedAt, "failed")
    .pipe(
      Effect.catchTag("DbQueryFailed", (error) =>
        Effect.logWarning("Could not mark a dead-lettered sync as failed", { reason: error.reason }),
      ),
    );
});

// The sync already ran, so a bill that fails is logged and the message still settles. A retry would read GitHub again.
const bill = (body: StarSync.SyncRequest | StarSync.LoginSyncRequest, report: StarSync.SyncReport) =>
  SyncRequests.billSync("accountId" in body ? undefined : body.reserved, report.requests).pipe(
    Effect.catchTags({
      DbQueryFailed: (error) => Effect.logWarning("Could not bill a sync to the line", { reason: error.reason }),
      DbRowInvalid: (error) => Effect.logWarning("Could not bill a sync to the line", { column: error.column }),
    }),
  );

export const pipeline = Settle.pipeline({
  schema: Schema.Union([StarSync.SyncRequest, StarSync.LoginSyncRequest]),
  run: Effect.fn("SyncStarsConsumer.run")(function* (bodies) {
    const starSync = yield* StarSync.StarSync;
    return yield* Effect.forEach(bodies, (request) =>
      ("accountId" in request ? starSync.sync(request) : starSync.syncLogin(request)).pipe(
        Effect.tap((report) => bill(request, report)),
        Effect.as(Settle.Settlement.Done()),
        Effect.result,
      ),
    );
  }),
  describe: (body) =>
    "accountId" in body ? { accountId: body.accountId, mode: body.mode } : { login: body.login, mode: body.mode },
  onDeadLetter: markFailed,
});
