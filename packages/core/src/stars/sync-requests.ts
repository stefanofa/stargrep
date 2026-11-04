import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequestLog from "./sync-request-log.ts";

export type SyncStatus =
  | { readonly state: "unknown" }
  | { readonly state: "queued"; readonly requestedAt: DateTime.Utc; readonly syncedAt: DateTime.Utc | null }
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

// A request or a sync this recent makes another request return the current status instead of
// sending a message, so repeated triggers for one login cost the GitHub budget nothing.
export const cooldown = Duration.minutes(10);

// The GitHub budget can hold a message back until the hourly window resets, so a request stays
// queued for a day before the log forgets it.
export const requestLifetime = Duration.days(1);

const within = (window: Duration.Duration, now: DateTime.Utc) => (at: DateTime.Utc) =>
  Duration.isLessThan(DateTime.distance(at, now), window);

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const queue = yield* SyncQueue.SyncQueue;
  const log = yield* SyncRequestLog.SyncRequestLog;

  const lastRequest = (login: Login, now: DateTime.Utc) =>
    log.lastRequest(login).pipe(
      Effect.map(Option.filter(within(requestLifetime, now))),
      Effect.catchTags({
        SyncRequestLogFailed: (error) =>
          Effect.logWarning("Sync request log read failed", { operation: error.operation }).pipe(
            Effect.as(Option.none<DateTime.Utc>()),
          ),
      }),
    );

  const statusAt = Effect.fn("SyncRequests.statusAt")(function* (login: Login, now: DateTime.Utc) {
    const account = yield* db.accounts.byLogin(login);
    const syncedAt = Option.flatMapNullishOr(account, (found) => found.starsSyncedAt);
    const requestedAt = yield* lastRequest(login, now);
    if (
      Option.isSome(requestedAt) &&
      Option.match(syncedAt, {
        onNone: () => true,
        onSome: (synced) => DateTime.isLessThan(synced, requestedAt.value),
      })
    ) {
      return { state: "queued", requestedAt: requestedAt.value, syncedAt: Option.getOrNull(syncedAt) } as const;
    }
    return Option.match(syncedAt, {
      onNone: (): SyncStatus => ({ state: "unknown" }),
      onSome: (synced): SyncStatus => ({ state: "done", syncedAt: synced }),
    });
  });

  const normalized = (login: Login) => Login.make(login.toLowerCase());

  const status = Effect.fn("SyncRequests.status")(function* (login: Login) {
    return yield* statusAt(normalized(login), yield* DateTime.now);
  });

  const request = Effect.fn("SyncRequests.request")(function* (typed: Login) {
    const login = normalized(typed);
    const now = yield* DateTime.now;
    const current = yield* statusAt(login, now);
    const recent = within(cooldown, now);
    if (current.state === "queued" && recent(current.requestedAt)) return current;
    if (current.state === "done" && recent(current.syncedAt)) return current;
    yield* queue.send({ login, mode: "incremental" });
    yield* log.record(login, now, requestLifetime).pipe(
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
