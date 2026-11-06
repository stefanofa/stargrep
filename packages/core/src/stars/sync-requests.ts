import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as OwnerLookup from "./owner-lookup.ts";
import type { Mode } from "./star-sync.ts";
import * as SyncQueue from "./sync-queue.ts";

export const SyncState = Schema.Literals(["unknown", "waiting", "queued", "failed", "done"]);
export type SyncState = typeof SyncState.Type;

interface Looked {
  // How many repos the login starred on GitHub at Stargrep's latest look, null before it looked, 0 for an org.
  readonly starredTotal: number | null;
  readonly accountType: Db.Account["type"] | null;
}

export type SyncStatus = Looked &
  (
    | { readonly state: "unknown" }
    | {
        readonly state: "waiting";
        readonly requestedAt: DateTime.Utc;
        readonly startsAt: DateTime.Utc;
        readonly ahead: number;
        readonly syncedAt: DateTime.Utc | null;
      }
    | {
        readonly state: "queued" | "failed";
        readonly requestedAt: DateTime.Utc;
        readonly syncedAt: DateTime.Utc | null;
      }
    | { readonly state: "done"; readonly syncedAt: DateTime.Utc }
  );

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

true satisfies Equals<SyncState, SyncStatus["state"]>;

export class LoginNotFound extends Schema.TaggedError<LoginNotFound, { readonly brand: unique symbol }>()(
  "LoginNotFound",
  {
    login: Schema.String,
  },
) {
  override get message(): string {
    return `GitHub has no user or org with the login ${this.login}`;
  }
}

export class SyncBusy extends Schema.TaggedError<SyncBusy, { readonly brand: unique symbol }>()("SyncBusy", {
  reason: Schema.Literals(["line-full", "github-budget"]),
}) {
  override get message(): string {
    return `Stargrep cannot start another GitHub import now: ${this.reason}`;
  }
}

export class NewAccountLimited extends Schema.TaggedError<NewAccountLimited, { readonly brand: unique symbol }>()(
  "NewAccountLimited",
  {},
) {
  override get message(): string {
    return "This caller started as many new logins as it may for now";
  }
}

export type SyncStatusError = DbQueryFailed | DbRowInvalid;

export type SyncRequestError =
  | SyncStatusError
  | SyncQueue.SyncQueueFailed
  | OwnerLookup.OwnerLookupFailed
  | LoginNotFound
  | SyncBusy
  | NewAccountLimited;

export type Requester = { readonly _tag: "owner" } | { readonly _tag: "anyone"; readonly caller: Db.CallerKey };

export class SyncRequests extends Context.Service<
  SyncRequests,
  {
    readonly request: (login: Login, by: Requester) => Effect.Effect<SyncStatus, SyncRequestError>;
    readonly status: (login: Login) => Effect.Effect<SyncStatus, SyncStatusError>;
  }
>()("@stargrep/core/stars/sync-requests/SyncRequests") {}

// A unit is one GitHub request. Signed-out syncs together spend at most unitsPerHour of the token's share, up to
// burstUnits at once after a quiet spell. A sync that would wait in line longer than maxWait is refused.
export const line = { unitsPerHour: 2_000, burstUnits: 200, maxWait: Duration.hours(2) } as const;

const unit = Duration.millis(Duration.toMillis(Duration.hours(1)) / line.unitsPerHour);
const tolerance = Duration.times(unit, line.burstUnits);

// Each caller may start 4 logins that never synced at once, then one more every 15 minutes. A login GitHub does not
// have counts too.
export const callerLimit = { burst: 4, every: Duration.minutes(15) } as const;

// A missing login or an org costs its lookup and nothing more.
export const lookupCost = 1;

// A page holds 100 stars. A first or full read reads every page and counts the stars through GraphQL before and after.
// An incremental read stops at the first star older than the newest one already stored, so it reads the stars added
// since, that one, and the next.
export type StarRead =
  | { readonly _tag: "every"; readonly starredTotal: number }
  | { readonly _tag: "since"; readonly starredTotal: number; readonly storedStars: number };

const pagesOf = (read: StarRead) =>
  read._tag === "every"
    ? Math.max(1, Math.ceil(read.starredTotal / 100))
    : Math.ceil((Math.max(0, read.starredTotal - read.storedStars) + 2) / 100);

// What a sync is expected to request: the account read, the counts, and the star pages. Only the read shows where it
// stops, because stars removed, starred again, or swapped at an unchanged total all move it, so this is an estimate.
export const costOf = (read: StarRead): number => 1 + (read._tag === "every" ? 2 : 0) + pagesOf(read);

const reserve = (db: Db.Db["Service"], at: DateTime.Utc, units: number, force: boolean) =>
  db.syncLine.reserve({
    line: "all",
    at,
    cost: Duration.times(unit, units),
    tolerance,
    maxWait: line.maxWait,
    force,
  });

// A sync that has run pays the line, forced, for the GitHub requests it made past what admission reserved for it, so
// the next signed-out start moves later by the difference. A message that reserved nothing pays for every request.
export const billSync = Effect.fn("SyncRequests.billSync")(function* (reserved: number | undefined, requests: number) {
  const owed = Math.max(0, requests - (reserved ?? 0));
  yield* Effect.annotateCurrentSpan({ "sync.requests": requests, "sync.owed": owed });
  if (owed === 0) return;
  yield* reserve(yield* Db.Db, yield* DateTime.now, owed, true);
});

type Decision =
  | "started"
  | "waiting"
  | "deduped"
  | "org"
  | "not-found"
  | "caller-limit"
  | "line-full"
  | "github-budget"
  | "lookup-failed";

export const admissions = Metric.counter("stargrep_sync_admissions", {
  description:
    "Sync requests by admission decision: started, waiting, deduped, org, not-found, caller-limit, line-full, github-budget, lookup-failed.",
});

const decide = (decision: Decision, cost = 0, wait = Duration.zero) =>
  Effect.all([
    Metric.update(Metric.withAttributes(admissions, { decision }), 1),
    Effect.annotateCurrentSpan({
      "sync.admission.decision": decision,
      "sync.admission.cost": cost,
      "sync.admission.wait_seconds": Math.ceil(Duration.toSeconds(wait)),
    }),
  ]);

interface Policy {
  readonly cooldown: Duration.Duration;
  readonly fullSyncEvery: Option.Option<Duration.Duration>;
  // Takes the login over from a request still waiting in line, whose sync then runs once more later.
  readonly overtakesWaiting: boolean;
}

// Anyone can ask for any login, so their cooldown is long. The owner asks on every library open, and a weekly full
// read is the only sync that finds the stars they removed. Owners pay into the line but never wait in it.
const policies: Record<Requester["_tag"], Policy> = {
  anyone: { cooldown: Duration.minutes(10), fullSyncEvery: Option.none(), overtakesWaiting: false },
  owner: { cooldown: Duration.minutes(1), fullSyncEvery: Option.some(Duration.days(7)), overtakesWaiting: true },
};

// A queued sync may still be reading pages. An account's first sync has no stop line, so a second request would read
// every star again. Every requester waits this long for a queued request. A cooldown counts from a finished or failed one.
const queuedWait = Duration.minutes(10);

export const requestLifetime = Duration.days(1);

// A claim writes starts_at once its message is sent, so a pending row without one is a claim whose lookup or
// reservation still runs. The lookup gives up after 5 seconds, so a request that finds such a claim reads the row again
// every 250 ms, up to 24 times, before it answers from the row as it stands.
const claimWait = { every: Duration.millis(250), reads: 24 } as const;

const inFlight = (row: Option.Option<Db.SyncRequest>) =>
  Option.exists(row, (found) => found.outcome === "pending" && found.startsAt === null);

const within = (window: Duration.Duration, now: DateTime.Utc) => (at: DateTime.Utc) =>
  Duration.isLessThan(DateTime.distance(at, now), window);

const lookedOf = (account: Option.Option<Db.Account>): Looked => ({
  starredTotal: Option.getOrNull(Option.flatMapNullishOr(account, (found) => found.starredCount)),
  accountType: Option.getOrNull(Option.map(account, (found) => found.type)),
});

// A missing login is no request: its row only answers triggers that GitHub has no such login. A waiting request's
// ahead is left at 0 here, and read counts it.
const statusOf = (
  account: Option.Option<Db.Account>,
  stored: Option.Option<Db.SyncRequest>,
  now: DateTime.Utc,
): SyncStatus => {
  const looked = lookedOf(account);
  const syncedAt = Option.getOrNull(Option.flatMapNullishOr(account, (found) => found.starsSyncedAt));
  const request = Option.filter(
    stored,
    (found) => found.outcome !== "missing" && within(requestLifetime, now)(found.requestedAt),
  );
  if (Option.isSome(request) && (syncedAt === null || DateTime.isLessThan(syncedAt, request.value.requestedAt))) {
    const { requestedAt, outcome, startsAt } = request.value;
    if (outcome === "failed") return { state: "failed", requestedAt, syncedAt, ...looked };
    if (startsAt !== null && DateTime.isGreaterThan(startsAt, now)) {
      return { state: "waiting", requestedAt, startsAt, ahead: 0, syncedAt, ...looked };
    }
    return { state: "queued", requestedAt, syncedAt, ...looked };
  }
  return syncedAt === null ? { state: "unknown", ...looked } : { state: "done", syncedAt, ...looked };
};

const syncedAtOf = (status: SyncStatus) => (status.state === "unknown" ? null : status.syncedAt);

// Only a full read finds unstars. It waits while a request is queued, because that sync may still be reading. A
// request still waiting in line has not started reading.
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
  const owners = yield* OwnerLookup.OwnerLookup;

  const read = Effect.fn("SyncRequests.read")(function* (login: Login, now: DateTime.Utc) {
    const [account, stored] = yield* Effect.all([db.accounts.byLogin(login), db.syncRequests.get(login)], {
      concurrency: 2,
    });
    const status = statusOf(account, stored, now);
    return {
      account,
      stored,
      status:
        status.state === "waiting" ? { ...status, ahead: yield* db.syncRequests.ahead(status.startsAt, now) } : status,
      fullSyncedAt: Option.flatMapNullishOr(account, (found) => found.starsFullSyncedAt),
    };
  });

  const status = Effect.fn("SyncRequests.status")(function* (login: Login) {
    return (yield* read(login, yield* DateTime.now)).status;
  });

  const reserveNewLogin = (caller: Db.CallerKey, at: DateTime.Utc) =>
    db.syncLine.reserve({
      line: Db.callerLine(caller),
      at,
      cost: callerLimit.every,
      tolerance: Duration.times(callerLimit.every, callerLimit.burst - 1),
      maxWait: Duration.zero,
      force: false,
    });

  const starRead = (login: Login, readsEveryPage: boolean, starredTotal: number) =>
    readsEveryPage
      ? Effect.succeed<StarRead>({ _tag: "every", starredTotal })
      : Effect.map(
          db.stars.enrichment(login),
          ({ total }): StarRead => ({ _tag: "since", starredTotal, storedStars: total }),
        );

  // A lookup GitHub answered spent a request whatever comes of the sync, so it always pays into the line.
  const payLookup = (at: DateTime.Utc) => reserve(db, at, lookupCost, true);

  const awaitClaim = (login: Login) =>
    db.syncRequests
      .get(login)
      .pipe(Effect.delay(claimWait.every), Effect.repeat({ while: inFlight, times: claimWait.reads - 1 }));

  // The message goes out before starts_at is written. A crash in between leaves a row that others wait on and then read
  // as queued while its job waits in the queue, instead of a login held until starts_at with no job behind it.
  const start = Effect.fn("SyncRequests.start")(function* (
    login: Login,
    at: DateTime.Utc,
    sync: { readonly mode: Mode; readonly reserved: number; readonly startsAt: DateTime.Utc },
    fields: Looked & { readonly syncedAt: DateTime.Utc | null },
  ) {
    const { mode, reserved, startsAt } = sync;
    const delay = DateTime.isGreaterThan(startsAt, at) ? DateTime.distance(at, startsAt) : Duration.zero;
    yield* queue
      .send({ login, mode, requestedAt: at, reserved }, delay)
      .pipe(Effect.tapError(() => db.syncRequests.settle(login, at, "failed").pipe(Effect.ignore)));
    yield* db.syncRequests.schedule(login, at, startsAt);
    if (Duration.isZero(delay)) return { state: "queued", requestedAt: at, ...fields } satisfies SyncStatus;
    const ahead = yield* db.syncRequests.ahead(startsAt, at);
    return { state: "waiting", requestedAt: at, startsAt, ahead, ...fields } satisfies SyncStatus;
  });

  // A request that finds another's claim in flight waits for its outcome, then decides once more by the same rules.
  // Untraced, so that second pass marks the request's span with its decision.
  const admit = Effect.fnUntraced(function* (
    login: Login,
    by: Requester,
    waitsForClaim: boolean,
  ): Effect.fn.Return<SyncStatus, SyncRequestError> {
    const policy = policies[by._tag];
    const now = yield* DateTime.now;
    const { account, stored, status: current, fullSyncedAt } = yield* read(login, now);
    if (current.state === "done" && within(policy.cooldown, now)(current.syncedAt)) {
      yield* decide("deduped");
      return current;
    }
    const afterClaim = () => awaitClaim(login).pipe(Effect.andThen(admit(login, by, false)));
    const busy = current.state === "queued" || current.state === "waiting";
    const cooldown = busy ? Duration.max(queuedWait, policy.cooldown) : policy.cooldown;
    const held =
      policy.overtakesWaiting && current.state === "waiting"
        ? Option.none()
        : Option.filter(stored, (row) =>
            DateTime.isGreaterThan(DateTime.addDuration(row.startsAt ?? row.requestedAt, cooldown), now),
          );
    const missing = (row: Option.Option<Db.SyncRequest>) =>
      by._tag === "anyone" && Option.exists(row, (found) => found.outcome === "missing");
    const notFound = decide("not-found").pipe(Effect.andThen(Effect.fail(new LoginNotFound({ login }))));
    if (waitsForClaim && inFlight(held)) return yield* afterClaim();
    if (missing(held)) return yield* notFound;
    if (Option.isSome(held)) {
      yield* decide("deduped");
      return current;
    }

    const syncedAt = syncedAtOf(current);
    const neverSynced = syncedAt === null;
    if (by._tag === "anyone") {
      const wait = yield* db.syncLine.wait("all", now, tolerance);
      if (Duration.isGreaterThan(wait, line.maxWait)) {
        yield* decide("line-full", 0, wait);
        return yield* new SyncBusy({ reason: "line-full" });
      }
    }

    const claim = { login, at: now, cooldown, lifetime: requestLifetime, overtakesWaiting: policy.overtakesWaiting };
    if (!(yield* db.syncRequests.claim(claim))) {
      if (waitsForClaim) return yield* afterClaim();
      const winner = yield* read(login, now);
      if (missing(winner.stored)) return yield* notFound;
      yield* decide("deduped");
      return winner.status;
    }
    if (by._tag === "anyone" && neverSynced && Option.isNone(yield* reserveNewLogin(by.caller, now))) {
      yield* db.syncRequests.settle(login, now, "released");
      yield* decide("caller-limit");
      return yield* new NewAccountLimited();
    }
    const mode = fullReadDue(policy, current, fullSyncedAt, now) ? "full" : "incremental";

    if (by._tag === "owner") {
      const starredTotal = Option.getOrElse(
        Option.flatMapNullishOr(account, (found) => found.starredCount),
        () => 0,
      );
      const cost = costOf(yield* starRead(login, neverSynced || mode === "full", starredTotal));
      yield* reserve(db, now, cost, true);
      yield* decide("started", cost);
      return yield* start(login, now, { mode, reserved: cost, startsAt: now }, { ...lookedOf(account), syncedAt });
    }

    const found = yield* owners
      .lookup(login)
      .pipe(
        Effect.tapError((error) =>
          Effect.all([
            db.syncRequests.settle(login, now, "released").pipe(Effect.ignore),
            decide(error._tag === "SyncBusy" ? "github-budget" : "lookup-failed"),
          ]),
        ),
      );
    if (Option.isNone(found)) {
      yield* db.syncRequests.settle(login, now, "missing");
      yield* payLookup(now);
      yield* decide("not-found", lookupCost);
      return yield* new LoginNotFound({ login });
    }
    const { account: facts, starredTotal } = found.value;
    yield* db.accounts.upsert(facts, starredTotal);
    const looked: Looked = { starredTotal, accountType: facts.type };

    if (facts.type === "org") {
      yield* payLookup(now);
      // The facts were written just above, so the account row exists.
      yield* db.accounts
        .recordStarSync({ accountId: facts.id, etag: null, at: now })
        .pipe(Effect.catchTags({ AccountNotFound: Effect.die }));
      // An org has nothing to send, so its claim starts now and no request waits on it.
      yield* db.syncRequests.schedule(login, now, now);
      yield* decide("org", lookupCost);
      return { state: "done", syncedAt: now, ...looked } satisfies SyncStatus;
    }

    const work = costOf(yield* starRead(login, neverSynced, starredTotal));
    const cost = lookupCost + work;
    const startsAt = yield* reserve(db, now, cost, false);
    if (Option.isNone(startsAt)) {
      yield* db.syncRequests.settle(login, now, "released");
      yield* payLookup(now);
      yield* decide("line-full", lookupCost);
      return yield* new SyncBusy({ reason: "line-full" });
    }
    const wait = DateTime.isGreaterThan(startsAt.value, now) ? DateTime.distance(now, startsAt.value) : Duration.zero;
    yield* decide(Duration.isZero(wait) ? "started" : "waiting", cost, wait);
    return yield* start(login, now, { mode, reserved: work, startsAt: startsAt.value }, { ...looked, syncedAt });
  });

  const request = Effect.fn("SyncRequests.request")(function* (login: Login, by: Requester) {
    return yield* admit(login, by, true);
  });

  return SyncRequests.of({ request, status });
});

export const layer = Layer.effect(SyncRequests, make);
