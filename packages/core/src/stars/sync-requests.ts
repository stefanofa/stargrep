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

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

true satisfies Equals<SyncState, SyncStatus["state"]>;

export type SyncStatusError = DbQueryFailed | DbRowInvalid;

export type SyncRequestError = SyncStatusError | SyncQueue.SyncQueueFailed;

export class SyncRequests extends Context.Service<
  SyncRequests,
  {
    readonly request: (login: Login, by: Requester) => Effect.Effect<SyncStatus, SyncRequestError>;
    readonly status: (login: Login) => Effect.Effect<SyncStatus, SyncStatusError>;
  }
>()("@stargrep/core/stars/sync-requests/SyncRequests") {}

export type Requester = "anyone" | "owner";

interface Policy {
  readonly cooldown: Duration.Duration;
  readonly fullSyncEvery: Option.Option<Duration.Duration>;
}

// Anyone can ask for any login, so their cooldown is long. The owner asks on every library open, and a weekly full
// read is the only sync that finds the stars they removed.
const policies: Record<Requester, Policy> = {
  anyone: { cooldown: Duration.minutes(10), fullSyncEvery: Option.none() },
  owner: { cooldown: Duration.minutes(1), fullSyncEvery: Option.some(Duration.days(7)) },
};

// A queued sync may still be reading pages. An account's first sync has no stop line, so a second request would read
// every star again. Every requester waits this long for a queued request. A cooldown counts from a finished or failed one.
const queuedWait = Duration.minutes(10);

export const requestLifetime = Duration.days(1);

const within = (window: Duration.Duration, now: DateTime.Utc) => (at: DateTime.Utc) =>
  Duration.isLessThan(DateTime.distance(at, now), window);

const statusOf = (
  account: Option.Option<Db.Account>,
  stored: Option.Option<Db.SyncRequest>,
  now: DateTime.Utc,
): SyncStatus => {
  const syncedAt = Option.getOrNull(Option.flatMapNullishOr(account, (found) => found.starsSyncedAt));
  const request = Option.filter(stored, (found) => within(requestLifetime, now)(found.requestedAt));
  if (Option.isSome(request) && (syncedAt === null || DateTime.isLessThan(syncedAt, request.value.requestedAt))) {
    const state = request.value.outcome === "failed" ? "failed" : "queued";
    return { state, requestedAt: request.value.requestedAt, syncedAt };
  }
  return syncedAt === null ? { state: "unknown" } : { state: "done", syncedAt };
};

// Only a full read finds unstars. It waits while a request is queued, because that sync may still be reading.
const fullReadDue = (
  policy: Policy,
  current: SyncStatus,
  fullSyncedAt: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
) =>
  current.state !== "queued" &&
  Option.exists(policy.fullSyncEvery, (every) =>
    Option.match(fullSyncedAt, {
      onNone: () => true,
      onSome: (at) => Duration.isGreaterThanOrEqualTo(DateTime.distance(at, now), every),
    }),
  );

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const queue = yield* SyncQueue.SyncQueue;

  const read = Effect.fn("SyncRequests.read")(function* (login: Login, now: DateTime.Utc) {
    const [account, stored] = yield* Effect.all([db.accounts.byLogin(login), db.syncRequests.get(login)], {
      concurrency: 2,
    });
    return {
      status: statusOf(account, stored, now),
      fullSyncedAt: Option.flatMapNullishOr(account, (found) => found.starsFullSyncedAt),
    };
  });

  const status = Effect.fn("SyncRequests.status")(function* (login: Login) {
    return (yield* read(login, yield* DateTime.now)).status;
  });

  const request = Effect.fn("SyncRequests.request")(function* (login: Login, by: Requester) {
    const policy = policies[by];
    const now = yield* DateTime.now;
    const { status: current, fullSyncedAt } = yield* read(login, now);
    if (current.state === "done" && within(policy.cooldown, now)(current.syncedAt)) return current;
    const cooldown = current.state === "queued" ? Duration.max(queuedWait, policy.cooldown) : policy.cooldown;
    if (!(yield* db.syncRequests.claim({ login, at: now, cooldown, lifetime: requestLifetime }))) {
      return (yield* read(login, now)).status;
    }
    const mode = fullReadDue(policy, current, fullSyncedAt, now) ? "full" : "incremental";
    yield* queue
      .send({ login, mode, requestedAt: now })
      .pipe(Effect.tapError(() => db.syncRequests.markFailed(login, now).pipe(Effect.ignore)));
    return {
      state: "queued",
      requestedAt: now,
      syncedAt: current.state === "unknown" ? null : current.syncedAt,
    } satisfies SyncStatus;
  });

  return SyncRequests.of({ request, status });
});

export const layer = Layer.effect(SyncRequests, make);
