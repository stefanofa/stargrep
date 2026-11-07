import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { BudgetShare, Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
    return "This network has spent its share of GitHub requests for now";
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

// A signed-in requester's own token pays for the sync, so it takes no turn in the line all. Signed in or not, a request
// for another login still pays its network's line.
export type Requester =
  | { readonly _tag: "owner"; readonly userId: UserId }
  | { readonly _tag: "signed-in"; readonly userId: UserId; readonly caller: Db.CallerKey }
  | { readonly _tag: "anyone"; readonly caller: Db.CallerKey };

export class SyncRequests extends Context.Service<
  SyncRequests,
  {
    readonly request: (login: Login, by: Requester) => Effect.Effect<SyncStatus, SyncRequestError>;
    readonly status: (login: Login) => Effect.Effect<SyncStatus, SyncStatusError>;
  }
>()("@stargrep/core/stars/sync-requests/SyncRequests") {}

// A rate line counts GitHub requests, a unit each. It pays out unitsPerHour, a reservation passes while the line owes
// at most burstUnits, and one that would start later than maxWait from now is refused.
export interface Rate {
  readonly unitsPerHour: number;
  readonly burstUnits: number;
  readonly maxWait: Duration.Duration;
}

// GitHub allows the token 5,000 REST requests an hour, and the gate lets Stargrep spend its budget share of them.
// Signed-out syncs together take turns in the line all, which pays out 80% of that share and leaves the rest to
// enrichment. A signed-in user's sync pays into it only for the requests that fell back to the server's token.
export const allRate = (share: BudgetShare): Rate => ({
  unitsPerHour: 0.8 * share * 5_000,
  burstUnits: 200,
  maxWait: Duration.hours(2),
});

// Each network pays a line of its own for every lookup it asks for and for the first read of a login that never synced,
// so one network can neither look logins up without end nor fill the line all.
const networkRate: Rate = { unitsPerHour: 150, burstUnits: 150, maxWait: Duration.zero };

const unitsOf = (rate: Rate, count: number) =>
  Duration.millis((count * Duration.toMillis(Duration.hours(1))) / rate.unitsPerHour);

const reservation = (key: Db.LineKey, rate: Rate, at: DateTime.Utc, count: number, force: boolean) => ({
  line: key,
  at,
  cost: unitsOf(rate, count),
  tolerance: unitsOf(rate, rate.burstUnits),
  maxWait: rate.maxWait,
  force,
});

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

const reserve = (db: Db.Db["Service"], line: Rate, at: DateTime.Utc, units: number, force: boolean) =>
  db.rateLines.reserve(reservation("all", line, at, units, force));

// After each delivery of a sync, whether it succeeded or failed, the line settles with the GitHub requests the token gate
// counted. reserved is what admission put in the line for this delivery. The delivery bills what it counted past that,
// or gives back what it did not use, and the line never moves earlier than now.
export const reconcileSync = Effect.fn("SyncRequests.reconcileSync")(function* (
  line: Rate,
  reserved: number,
  counted: number,
) {
  const owed = counted - reserved;
  yield* Effect.annotateCurrentSpan({ "sync.requests": counted, "sync.reserved": reserved, "sync.owed": owed });
  if (owed === 0) return;
  yield* (yield* Db.Db).rateLines.adjust("all", yield* DateTime.now, unitsOf(line, owed));
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

// What admission decided for one request. cost is what the request put in the line all, in units.
type Admission =
  | { readonly _tag: "Deduped"; readonly status: SyncStatus }
  | { readonly _tag: "Started"; readonly cost: number; readonly status: SyncStatus }
  | { readonly _tag: "Waiting"; readonly cost: number; readonly wait: Duration.Duration; readonly status: SyncStatus }
  | { readonly _tag: "Org"; readonly status: SyncStatus }
  | { readonly _tag: "NotFound"; readonly cost: number }
  | { readonly _tag: "CallerLimit" }
  | { readonly _tag: "LineFull"; readonly cost: number; readonly wait: Duration.Duration }
  | { readonly _tag: "LookupFailed"; readonly error: OwnerLookup.OwnerLookupFailed };

const record = (decision: Decision, cost: number, wait: Duration.Duration) =>
  Effect.all([
    Metric.update(Metric.withAttributes(admissions, { decision }), 1),
    Effect.annotateCurrentSpan({
      "sync.admission.decision": decision,
      "sync.admission.cost": cost,
      "sync.admission.wait_seconds": Math.ceil(Duration.toSeconds(wait)),
    }),
  ]);

// Counts the decision, marks the request's span, and answers it.
const decide = (
  login: Login,
  admission: Admission,
): Effect.Effect<SyncStatus, LoginNotFound | SyncBusy | NewAccountLimited | OwnerLookup.OwnerLookupFailed> => {
  switch (admission._tag) {
    case "Deduped":
      return Effect.as(record("deduped", 0, Duration.zero), admission.status);
    case "Started":
      return Effect.as(record("started", admission.cost, Duration.zero), admission.status);
    case "Waiting":
      return Effect.as(record("waiting", admission.cost, admission.wait), admission.status);
    case "Org":
      return Effect.as(record("org", lookupCost, Duration.zero), admission.status);
    case "NotFound":
      return Effect.andThen(
        record("not-found", admission.cost, Duration.zero),
        Effect.fail(new LoginNotFound({ login })),
      );
    case "CallerLimit":
      return Effect.andThen(record("caller-limit", 0, Duration.zero), Effect.fail(new NewAccountLimited()));
    case "LineFull":
      return Effect.andThen(
        record("line-full", admission.cost, admission.wait),
        Effect.fail(new SyncBusy({ reason: "line-full" })),
      );
    case "LookupFailed":
      return admission.error.reason === "budget"
        ? Effect.andThen(
            record("github-budget", 0, Duration.zero),
            Effect.fail(new SyncBusy({ reason: "github-budget" })),
          )
        : Effect.andThen(record("lookup-failed", 0, Duration.zero), Effect.fail(admission.error));
  }
};

// Anyone can ask for any login, so their cooldown is long. It also covers a queued sync still reading pages.
const anyoneCooldown = Duration.minutes(10);

// The owner asks on every library open, and a weekly full read is the only sync that finds the stars they removed.
// Owners pay into the line but never wait in it.
const ownerCooldown = Duration.minutes(1);
const fullReadEvery = Duration.days(7);

// A queued sync may still be reading pages. An account's first sync has no stop line, so a second request would read
// every star again. The owner waits this long for a queued request, and a cooldown counts from a finished or failed one.
const queuedWait = Duration.minutes(10);

export const requestLifetime = Duration.days(1);

// A request past its lifetime and a line the clock has passed both answer as if they had no row, so the prune only keeps
// the tables small.
export const prune = Effect.fn("SyncRequests.prune")(function* () {
  const db = yield* Db.Db;
  const now = yield* DateTime.now;
  yield* db.syncRequests.prune(DateTime.subtractDuration(now, requestLifetime));
  yield* db.rateLines.prune(now);
});

const within = (window: Duration.Duration, now: DateTime.Utc) => (at: DateTime.Utc) =>
  Duration.isLessThan(DateTime.distance(at, now), window);

// A row holds its login for the cooldown, counted from when its sync starts.
const holds = (cooldown: Duration.Duration, now: DateTime.Utc) => (row: Db.SyncRequest) =>
  DateTime.isGreaterThan(DateTime.addDuration(row.startsAt ?? row.requestedAt, cooldown), now);

const lookedOf = (account: Option.Option<Db.Account>): Looked => ({
  starredTotal: Option.getOrNull(Option.flatMapNullishOr(account, (found) => found.starredCount)),
  accountType: Option.getOrNull(Option.map(account, (found) => found.type)),
});

// A missing login is no request: its row only answers triggers that GitHub has no such login. A claimed request is
// about to send its sync, so it reads as queued. A waiting request's ahead is left at 0 here, and read counts it.
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

const make = Effect.fnUntraced(function* (share: BudgetShare) {
  const line = allRate(share);
  const tolerance = unitsOf(line, line.burstUnits);
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

  const starRead = (login: Login, readsEveryPage: boolean, starredTotal: number) =>
    readsEveryPage
      ? Effect.succeed<StarRead>({ _tag: "every", starredTotal })
      : Effect.map(
          db.stars.enrichment(login),
          ({ total }): StarRead => ({ _tag: "since", starredTotal, storedStars: total }),
        );

  // A signed-out request that loses the claim answers from the row that won it.
  const fromWinner = Effect.fnUntraced(function* (login: Login, now: DateTime.Utc) {
    const winner = yield* read(login, now);
    return Option.exists(winner.stored, (row) => row.outcome === "missing")
      ? ({ _tag: "NotFound", cost: lookupCost } satisfies Admission)
      : ({ _tag: "Deduped", status: winner.status } satisfies Admission);
  });

  // The message goes out before the row is scheduled. A crash in between leaves a claimed row, which reads as queued
  // while its job waits in the queue, instead of a login held until starts_at with no job behind it.
  const start = Effect.fn("SyncRequests.start")(function* (
    login: Login,
    at: DateTime.Utc,
    sync: {
      readonly mode: Mode;
      readonly reserved: number;
      readonly startsAt: DateTime.Utc;
      readonly cost: number;
      readonly userId: UserId | undefined;
    },
    fields: Looked & { readonly syncedAt: DateTime.Utc | null },
  ) {
    const { mode, reserved, startsAt, cost, userId } = sync;
    const wait = DateTime.isGreaterThan(startsAt, at) ? DateTime.distance(at, startsAt) : Duration.zero;
    const paidBy = userId === undefined ? {} : { userId };
    // A refused message runs no sync, so the units reserved for it go back to the line.
    yield* queue
      .send({ login, mode, requestedAt: at, reserved, ...paidBy }, wait)
      .pipe(
        Effect.tapError(() =>
          Effect.all([
            db.syncRequests.settle(login, at, "failed"),
            db.rateLines.adjust("all", at, unitsOf(line, -reserved)),
          ]).pipe(Effect.ignore),
        ),
      );
    yield* db.syncRequests.schedule(login, at, startsAt);
    if (Duration.isZero(wait)) {
      return { _tag: "Started", cost, status: { state: "queued", requestedAt: at, ...fields } } satisfies Admission;
    }
    const ahead = yield* db.syncRequests.ahead(startsAt, at);
    const status: SyncStatus = { state: "waiting", requestedAt: at, startsAt, ahead, ...fields };
    return { _tag: "Waiting", cost, wait, status } satisfies Admission;
  });

  // The owner's sync runs on their own token, so it reserves nothing in the line all and never waits. It needs no lookup,
  // because sign-in already read their account. The owner's claim takes over a request still waiting in line, and runs
  // a full read when one is due.
  const admitOwner = Effect.fnUntraced(function* (
    login: Login,
    userId: UserId,
  ): Effect.fn.Return<Admission, SyncRequestError> {
    const now = yield* DateTime.now;
    const { account, stored, status: current, fullSyncedAt } = yield* read(login, now);
    if (current.state === "done" && within(ownerCooldown, now)(current.syncedAt)) {
      return { _tag: "Deduped", status: current };
    }
    const cooldown = current.state === "queued" || current.state === "waiting" ? queuedWait : ownerCooldown;
    if (current.state !== "waiting" && Option.exists(stored, holds(cooldown, now))) {
      return { _tag: "Deduped", status: current };
    }
    const claim = { login, at: now, cooldown, overtakesWaiting: true, outcome: "claimed" } as const;
    if (!(yield* db.syncRequests.claim(claim))) return { _tag: "Deduped", status: (yield* read(login, now)).status };

    const syncedAt = syncedAtOf(current);
    const fullReadDue =
      current.state !== "queued" &&
      Option.match(fullSyncedAt, {
        onNone: () => true,
        onSome: (at) => Duration.isGreaterThanOrEqualTo(DateTime.distance(at, now), fullReadEvery),
      });
    const mode = fullReadDue ? "full" : "incremental";
    return yield* start(
      login,
      now,
      { mode, reserved: 0, startsAt: now, cost: 0, userId },
      { ...lookedOf(account), syncedAt },
    );
  });

  // A request for another login looks it up before it claims it, so its claim already knows whether the login exists,
  // and no request ever waits on another's lookup. Requests for the same login at once each pay a lookup. A signed-in
  // requester's token pays for the sync, so it skips the line all and starts now.
  const admitAnyone = Effect.fnUntraced(function* (
    login: Login,
    caller: Db.CallerKey,
    userId: UserId | undefined,
  ): Effect.fn.Return<Admission, SyncRequestError> {
    const now = yield* DateTime.now;
    const { stored, status: current } = yield* read(login, now);
    if (current.state === "done" && within(anyoneCooldown, now)(current.syncedAt)) {
      return { _tag: "Deduped", status: current };
    }
    // A signed-in requester never waits, so a request still waiting in line does not hold the login for them.
    const overtakes = userId !== undefined && current.state === "waiting";
    const held = overtakes ? Option.none() : Option.filter(stored, holds(anyoneCooldown, now));
    if (Option.isSome(held)) {
      return held.value.outcome === "missing" ? { _tag: "NotFound", cost: 0 } : { _tag: "Deduped", status: current };
    }

    if (userId === undefined) {
      const wait = yield* db.rateLines.wait("all", now, tolerance);
      if (Duration.isGreaterThan(wait, line.maxWait)) return { _tag: "LineFull", cost: 0, wait };
    }
    const network = Db.callerLine(caller);
    const charge = (units: number) => db.rateLines.reserve(reservation(network, networkRate, now, units, false));
    if (Option.isNone(yield* charge(lookupCost))) return { _tag: "CallerLimit" };

    const found = yield* Effect.result(owners.lookup(login));
    if (Result.isFailure(found)) return { _tag: "LookupFailed", error: found.failure };
    // GitHub answered, so the lookup spent a request whatever comes of the sync.
    yield* reserve(db, line, now, lookupCost, true);
    const claim = (outcome: "claimed" | "missing") =>
      db.syncRequests.claim({ login, at: now, cooldown: anyoneCooldown, overtakesWaiting: overtakes, outcome });

    if (Option.isNone(found.success)) {
      if (!(yield* claim("missing"))) return yield* fromWinner(login, now);
      return { _tag: "NotFound", cost: lookupCost };
    }
    const owner = found.success.value;
    yield* db.accounts.upsertLooked(owner);
    const looked: Looked = { starredTotal: owner.starredTotal, accountType: owner.account.type };
    if (!(yield* claim("claimed"))) return yield* fromWinner(login, now);

    if (owner.account.type === "org") {
      // The facts were written just above, so the account row exists.
      yield* db.accounts
        .recordStarSync({ accountId: owner.account.id, at: now })
        .pipe(Effect.catchTags({ AccountNotFound: Effect.die }));
      // An org has nothing to send, so its claim starts now.
      yield* db.syncRequests.schedule(login, now, now);
      return { _tag: "Org", status: { state: "done", syncedAt: now, ...looked } };
    }

    const syncedAt = syncedAtOf(current);
    const work = costOf(yield* starRead(login, syncedAt === null, owner.starredTotal));
    // A first read goes on its network's line too, refused once the network owes its burst, so a network starts one
    // huge import and not several at once. A takeover runs the import a waiting request's network already paid for, so
    // it pays no first read again, and a takeover is never refused after it replaced the waiting request.
    const networkWork = syncedAt === null && !overtakes ? work : 0;
    if (networkWork > 0 && Option.isNone(yield* charge(networkWork))) {
      yield* db.syncRequests.settle(login, now, "released");
      return { _tag: "CallerLimit" };
    }
    if (userId !== undefined) {
      return yield* start(
        login,
        now,
        { mode: "incremental", reserved: 0, startsAt: now, cost: lookupCost, userId },
        { ...looked, syncedAt },
      );
    }
    const startsAt = yield* reserve(db, line, now, work, false);
    if (Option.isNone(startsAt)) {
      yield* db.syncRequests.settle(login, now, "released");
      if (networkWork > 0) yield* db.rateLines.adjust(network, now, unitsOf(networkRate, -networkWork));
      return { _tag: "LineFull", cost: lookupCost, wait: line.maxWait };
    }
    return yield* start(
      login,
      now,
      { mode: "incremental", reserved: work, startsAt: startsAt.value, cost: lookupCost + work, userId: undefined },
      { ...looked, syncedAt },
    );
  });

  const request = Effect.fn("SyncRequests.request")(function* (login: Login, by: Requester) {
    const admission =
      by._tag === "owner"
        ? yield* admitOwner(login, by.userId)
        : yield* admitAnyone(login, by.caller, by._tag === "signed-in" ? by.userId : undefined);
    return yield* decide(login, admission);
  });

  return SyncRequests.of({ request, status });
});

export const layer = (share: BudgetShare) => Layer.effect(SyncRequests, make(share));
