import { StarSync } from "@stargrep/core/stars";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Settle from "./settle.ts";

export const SyncStarsMessage = Schema.Union([StarSync.SyncRequest, StarSync.LoginSyncRequest]);
const decodeMessage = Schema.decodeUnknownEffect(SyncStarsMessage);
const isMessage = Schema.is(SyncStarsMessage);

export const handle = Effect.fn("SyncStarsConsumer.handle")(function* (message: Settle.Message) {
  const decoded = yield* Effect.result(decodeMessage(message.body));
  if (Result.isFailure(decoded)) return Settle.Settlement.DeadLetter({ error: decoded.failure._tag });
  const request = decoded.success;
  const starSync = yield* StarSync.StarSync;
  const synced = yield* Effect.result("accountId" in request ? starSync.sync(request) : starSync.syncLogin(request));
  if (Result.isSuccess(synced)) return Settle.Settlement.Done();
  return Settle.afterFailure(synced.failure, yield* Clock.currentTimeMillis);
});

export const processBatch = Effect.fn("SyncStarsConsumer.processBatch")(function* (
  queues: Settle.Queues,
  messages: ReadonlyArray<Settle.Message>,
) {
  for (const message of messages) yield* Settle.settle(queues, message, yield* handle(message));
});

export const describe = (body: unknown) =>
  isMessage(body)
    ? "accountId" in body
      ? { accountId: body.accountId, mode: body.mode }
      : { login: body.login, mode: body.mode }
    : { bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body };
