import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequestLog from "./sync-request-log.ts";

export const SyncState = Schema.Literals(["unknown", "queued", "failed", "done"]);
export type SyncState = typeof SyncState.Type;

export type SyncStatus =
  | { readonly state: "unknown" }
  | {
      readonly state: "queued" | "failed";
      readonly requestedAt: DateTime.Utc;
      readonly syncedAt: DateTime.Utc | null;
    }
  | { readonly state: "done"; readonly syncedAt: DateTime.Utc };

export type SyncStatusError = DbQueryFailed | DbRowInvalid;

export type SyncRequestError = SyncStatusError | SyncQueue.SyncQueueFailed;

export class SyncRequests extends Context.Service<
  SyncRequests,
  {
    readonly request: (login: Login) => Effect.Effect<SyncStatus, SyncRequestError>;
    readonly status: (login: Login) => Effect.Effect<SyncStatus, SyncStatusError>;
  }
>()("@stargrep/core/stars/sync-requests/SyncRequests") {}

export const cooldown = Duration.minutes(10);

const within = (window: Duration.Duration, now: DateTime.Utc) => (at: DateTime.Utc) =>
  Duration.isLessThan(DateTime.distance(at, now), window);

const lastActivity = (status: SyncStatus) =>
  status.state === "unknown" ? null : status.state === "done" ? status.syncedAt : status.requestedAt;

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const queue = yield* SyncQueue.SyncQueue;
  const log = yield* SyncRequestLog.SyncRequestLog;

  const lastRequest = (login: Login, now: DateTime.Utc) =>
    log.lastRequest(login).pipe(
      Effect.map(Option.filter((request) => within(SyncRequestLog.requestLifetime, now)(request.requestedAt))),
      Effect.catchTags({
        SyncRequestLogFailed: (error) =>
          Effect.logWarning("Sync request log read failed", { operation: error.operation }).pipe(
            Effect.as(Option.none<SyncRequestLog.SyncRequest>()),
          ),
      }),
    );

  const statusAt = Effect.fn("SyncRequests.statusAt")(function* (
    login: Login,
    now: DateTime.Utc,
  ): Effect.fn.Return<SyncStatus, SyncStatusError> {
    const [account, request] = yield* Effect.all([db.accounts.byLogin(login), lastRequest(login, now)], {
      concurrency: 2,
    });
    const syncedAt = Option.getOrNull(Option.flatMapNullishOr(account, (found) => found.starsSyncedAt));
    if (Option.isSome(request) && (syncedAt === null || DateTime.isLessThan(syncedAt, request.value.requestedAt))) {
      const state = request.value.outcome === "failed" ? "failed" : "queued";
      return { state, requestedAt: request.value.requestedAt, syncedAt };
    }
    return syncedAt === null ? { state: "unknown" } : { state: "done", syncedAt };
  });

  const status = Effect.fn("SyncRequests.status")(function* (login: Login) {
    return yield* statusAt(login, yield* DateTime.now);
  });

  const request = Effect.fn("SyncRequests.request")(function* (login: Login) {
    const now = yield* DateTime.now;
    const current = yield* statusAt(login, now);
    const since = lastActivity(current);
    if (since !== null && within(cooldown, now)(since)) return current;
    yield* queue.send({ login, mode: "incremental" });
    yield* log.markPending(login, now).pipe(
      Effect.catchTags({
        SyncRequestLogFailed: (error) =>
          Effect.logWarning("Sync request log write failed", { operation: error.operation }),
      }),
    );
    return {
      state: "queued",
      requestedAt: now,
      syncedAt: current.state === "unknown" ? null : current.syncedAt,
    } satisfies SyncStatus;
  });

  return SyncRequests.of({ request, status });
});

export const layer = Layer.effect(SyncRequests, make);
