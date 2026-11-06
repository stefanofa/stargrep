import { StarSync, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { UserGates } from "../user-gate.ts";
import * as Settle from "./settle.ts";

const Body = Schema.Union([StarSync.SyncRequest, StarSync.LoginSyncRequest]);
type Body = typeof Body.Type;

const encodeBody = Schema.encodeSync(Body);

const markFailed = Effect.fn("SyncStarsConsumer.markFailed")(function* (body: Body) {
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

// A message's first delivery spends the units admission reserved for it. A later delivery, a deferred message sent
// again, and a message that reserved nothing pay for every request they make.
const reservedFor = ({ body, attempts }: Settle.Delivery<Body>) =>
  "accountId" in body || attempts > 1 ? 0 : (body.reserved ?? 0);

// The sync already ran, so a reconciliation that fails is logged and the message still settles. A retry would read
// GitHub again.
const reconcile = (line: SyncRequests.Rate, delivery: Settle.Delivery<Body>, counted: number) =>
  SyncRequests.reconcileSync(line, reservedFor(delivery), counted).pipe(
    Effect.catchTag("DbQueryFailed", (error) =>
      Effect.logWarning("Could not reconcile a sync with the line", { reason: error.reason }),
    ),
  );

// Each message runs on a token gate of its own that counts the requests it sends on the server's token, so the line is
// billed for what the sync spent there, failed and retried requests included. A sync a signed-in user started runs on
// their token first. The messages of a batch run at once, so such a sync never waits behind the server's syncs.
export const pipeline = <R>(
  line: SyncRequests.Rate,
  syncs: Layer.Layer<StarSync.StarSync, never, TokenGate.TokenGate | R>,
) =>
  Settle.pipeline({
    schema: Body,
    run: Effect.fn("SyncStarsConsumer.run")(function* (deliveries) {
      const gate = yield* TokenGate.TokenGate;
      const users = yield* UserGates;
      return yield* Effect.forEach(
        deliveries,
        (delivery) =>
          Effect.gen(function* () {
            const sent = yield* Ref.make(0);
            const { body } = delivery;
            const server = TokenGate.counting(gate, sent);
            const counted = Settle.onGate(syncs, yield* users.gate(body.userId, server));
            const synced = yield* StarSync.StarSync.use((starSync) =>
              "accountId" in body ? starSync.sync(body) : starSync.syncLogin(body),
            ).pipe(Effect.provide(counted), Effect.result);
            yield* reconcile(line, delivery, yield* Ref.get(sent));
            return Result.map(synced, () => Settle.Settlement.Done());
          }),
        { concurrency: "unbounded" },
      );
    }),
    describe: (body) =>
      "accountId" in body ? { accountId: body.accountId, mode: body.mode } : { login: body.login, mode: body.mode },
    onDeadLetter: markFailed,
    resend: (body) =>
      "accountId" in body || body.reserved === undefined
        ? Option.none()
        : Option.some(encodeBody(Struct.omit(body, ["reserved"]))),
  });
