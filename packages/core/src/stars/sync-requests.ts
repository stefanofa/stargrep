import * as Analytics from "@stargrep/analytics/analytics";
import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { BudgetShare, GitHubAccountId, Login } from "@stargrep/github/schemas";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Struct from "effect/Struct";
import * as RateLine from "../limits/rate-line.ts";
import * as OwnerLookup from "./owner-lookup.ts";
import { actorOf, type LoginSyncRequest, type Mode } from "./star-sync.ts";
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

// A unit is one GitHub request. A missing login or an org costs its lookup and nothing more.
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

// After each delivery of a sync, whether it succeeded or failed, githubAll settles with the GitHub requests the token
// gate counted on the server's token. A first delivery spends what admission reserved for it. It bills what it counted
// past that, or releases the unused end of the reservation through its receipt, which gives back only what the line
// still owes, so a delivery that settles late never credits work reserved after it. A later delivery, and a message
// that reserved nothing, bills its whole count. A message queued before receipts gives nothing back.
export const billDelivery = Effect.fn("SyncRequests.billDelivery")(function* (
  share: BudgetShare,
  delivery: { readonly body: LoginSyncRequest; readonly attempts: number },
  counted: number,
) {
  const all = RateLine.githubAll(share);
  const reserved = delivery.attempts > 1 ? undefined : delivery.body.reserved;
  const units = typeof reserved === "object" ? reserved.units : (reserved ?? 0);
  yield* Effect.annotateCurrentSpan({ "sync.requests": counted, "sync.reserved": units, "sync.owed": counted - units });
  const db = yield* Db.Db;
  const now = yield* DateTime.now;
  if (counted > units) {
    yield* RateLine.reserve(db.rateLines, all, now, counted - units, true);
  } else if (counted < units && typeof reserved === "object") {
    const { endsAt, generation, released } = reserved;
    const unused = RateLine.durationOf(all.rate, units - counted);
    yield* db.rateLines.release({ line: all.key, cost: unused, endsAt, generation, released }, now);
  }
});

// The body a deferred sync goes out again with, or none to send it as it arrived. Its delivery settled the
// reservation, so the next one bills in full.
export const resent = (body: LoginSyncRequest): Option.Option<LoginSyncRequest> =>
  body.reserved === undefined ? Option.none() : Option.some(Struct.omit(body, ["reserved"]));

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

// A queued sync may still be reading pages. An account's first sync has no stop line, so a second request would read
// every star again. Every requester waits this long for a queued request.
const queuedWait = Duration.minutes(10);
const fullReadEvery = Duration.days(7);

// What sets one kind of requester apart in admission. A new kind of requester is a new case of policyOf.
interface Policy {
  // The signed-in user whose token pays for the sync. Without one the server's token pays, so the sync first takes its
  // turn in githubAll. A requester whose own token pays never waits, so they take over a request still waiting in line.
  readonly paidBy: UserId | undefined;
  // The network that pays for looking the login up and for its first read. The owner has none, because sign-in already
  // read their account.
  readonly network: Db.CallerKey | undefined;
  // How long a finished or failed sync holds the login against this requester.
  readonly cooldown: Duration.Duration;
  // Whether a due weekly full read runs, the only sync that finds removed stars.
  readonly fullReads: boolean;
}

// Anyone can ask for any login, so they wait 10 minutes. The owner asks on every library open, so they wait a minute,
// and their library open is the one that runs the weekly full read.
const policyOf = (by: Requester): Policy => {
  switch (by._tag) {
    case "owner":
      return { paidBy: by.userId, network: undefined, cooldown: Duration.minutes(1), fullReads: true };
    case "signed-in":
      return { paidBy: by.userId, network: by.caller, cooldown: Duration.minutes(10), fullReads: false };
    case "anyone":
      return { paidBy: undefined, network: by.caller, cooldown: Duration.minutes(10), fullReads: false };
  }
};

// What a request's lookup paid into githubAll. The owner looks nothing up.
const lookupPaidBy = (policy: Policy) => (policy.network === undefined ? 0 : lookupCost);

// What a request knows about the login when it claims it: what a lookup found, or for the owner, their stored account.
type Found =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Org"; readonly accountId: GitHubAccountId; readonly looked: Looked }
  | { readonly _tag: "User"; readonly looked: Looked };

// A sync whose message went out, for its row to be scheduled.
interface Sent {
  readonly _tag: "Sent";
  readonly startsAt: DateTime.Utc;
  readonly cost: number;
  readonly fields: Looked & { readonly syncedAt: DateTime.Utc | null };
}

// Ends admission early with a refusal decided inside a step. Inside a claim, the claim and every charge go back first.
class Refused extends Data.TaggedError("Refused")<{ readonly admission: Admission }> {}

const refusedByQueue = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged("SyncQueueFailed"));

// Whether a request that ended with this exit stopped before its sync could have gone out. Once the send starts, the
// message is queued unless the queue refused it.
type Stopped = (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<boolean>;

const stoppedBefore =
  (sending: Ref.Ref<boolean>): Stopped =>
  (exit) =>
    Effect.map(Ref.get(sending), (started) => Exit.isFailure(exit) && (!started || refusedByQueue(exit)));

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
  const all = RateLine.githubAll(share);
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

  // A request that loses the claim answers from the row that won it. cost is what its own lookup paid.
  const fromWinner = Effect.fnUntraced(function* (login: Login, now: DateTime.Utc, cost: number) {
    const winner = yield* read(login, now);
    return Option.exists(winner.stored, (row) => row.outcome === "missing")
      ? ({ _tag: "NotFound", cost } satisfies Admission)
      : ({ _tag: "Deduped", status: winner.status } satisfies Admission);
  });

  // Looks the login up before the claim, so the claim already knows whether the login exists, and no request ever waits
  // on another's lookup. Requests for the same login at once each pay a lookup on their network's line.
  const lookUp = Effect.fnUntraced(function* (login: Login, network: RateLine.Line, now: DateTime.Utc) {
    if (Option.isNone(yield* RateLine.reserve(db.rateLines, network, now, lookupCost))) {
      return yield* new Refused({ admission: { _tag: "CallerLimit" } });
    }
    const found = yield* owners.lookup(login).pipe(
      Effect.catchTags({
        OwnerLookupFailed: (error) => Effect.fail(new Refused({ admission: { _tag: "LookupFailed", error } })),
      }),
    );
    // GitHub answered, so the lookup spent a request whatever comes of the sync.
    yield* RateLine.reserve(db.rateLines, all, now, lookupCost, true);
    if (Option.isNone(found)) return { _tag: "Missing" } satisfies Found;
    const owner = found.value;
    yield* db.accounts.upsertLooked(owner);
    const looked: Looked = { starredTotal: owner.starredTotal, accountType: owner.account.type };
    return owner.account.type === "org"
      ? ({ _tag: "Org", accountId: owner.account.id, looked } satisfies Found)
      : ({ _tag: "User", looked } satisfies Found);
  });

  // A won claim holds the login until its sync goes out. If the request stops first, the row is released, or marked
  // failed when the queue refused the message, so no login reads as queued with no job behind it.
  const claim = (login: Login, now: DateTime.Utc, claimed: Omit<Db.SyncClaim, "login" | "at">, stopped: Stopped) =>
    Effect.acquireRelease(db.syncRequests.claim({ login, at: now, ...claimed }), (won, exit) =>
      Effect.flatMap(stopped(exit), (stop) =>
        won && stop
          ? db.syncRequests.settle(login, now, refusedByQueue(exit) ? "failed" : "released").pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  // When the request stops before its sync goes out, a charge after the claim gives back what its line still owes for
  // it when the stop lands, so a late stop never credits work charged after it. A refused charge stops the request
  // with the decision it gives.
  const charge = (line: RateLine.Line, now: DateTime.Utc, units: number, refused: Admission, stopped: Stopped) =>
    Effect.acquireRelease(
      RateLine.reserve(db.rateLines, line, now, units).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Refused({ admission: refused })),
            onSome: Effect.succeed,
          }),
        ),
      ),
      (reserved, exit) =>
        Effect.flatMap(stopped(exit), (stop) =>
          stop
            ? DateTime.now.pipe(
                Effect.flatMap((at) => db.rateLines.release(reserved, at)),
                Effect.ignore,
              )
            : Effect.void,
        ),
    );

  // A first read goes on its network's line, refused once the network owes its burst, so a network starts one huge
  // import and not several at once. A takeover runs the import a waiting request's network already paid for, so it pays
  // no first read again. A sync on the server's token then takes its turn in githubAll, and its message goes out at the
  // start of that turn. An unknown starred total prices the smallest read, and the sync bills the rest after it runs.
  const send = Effect.fnUntraced(function* (
    login: Login,
    now: DateTime.Utc,
    policy: Policy,
    takesOver: boolean,
    current: { readonly status: SyncStatus; readonly fullSyncedAt: Option.Option<DateTime.Utc> },
    looked: Looked,
    sending: Ref.Ref<boolean>,
  ) {
    const stopped = stoppedBefore(sending);
    const syncedAt = syncedAtOf(current.status);
    const firstReadOn =
      policy.network !== undefined && syncedAt === null && !takesOver ? RateLine.githubNetwork(policy.network) : null;
    const waitsInLine = policy.paidBy === undefined;
    const work =
      firstReadOn !== null || waitsInLine
        ? costOf(yield* starRead(login, syncedAt === null, looked.starredTotal ?? 0))
        : 0;
    if (firstReadOn !== null) yield* charge(firstReadOn, now, work, { _tag: "CallerLimit" }, stopped);
    const turn = waitsInLine
      ? yield* charge(all, now, work, { _tag: "LineFull", cost: lookupCost, wait: all.rate.maxWait }, stopped)
      : undefined;
    const startsAt = turn?.startsAt ?? now;
    const reserved =
      turn === undefined
        ? {}
        : { reserved: { units: work, endsAt: turn.endsAt, generation: turn.generation, released: turn.released } };
    const fullReadDue =
      policy.fullReads &&
      current.status.state !== "queued" &&
      Option.match(current.fullSyncedAt, {
        onNone: () => true,
        onSome: (at) => Duration.isGreaterThanOrEqualTo(DateTime.distance(at, now), fullReadEvery),
      });
    const wait = DateTime.isGreaterThan(startsAt, now) ? DateTime.distance(now, startsAt) : Duration.zero;
    const requester =
      policy.paidBy !== undefined
        ? { userId: policy.paidBy }
        : policy.network === undefined
          ? {}
          : { caller: policy.network };
    const mode: Mode = fullReadDue ? "full" : "incremental";
    const message: LoginSyncRequest = { login, mode, requestedAt: now, ...reserved, ...requester };
    // An interruption lands before the send or after it finishes, so the flag says whether the message may be queued.
    yield* Ref.set(sending, true).pipe(Effect.andThen(queue.send(message, wait)), Effect.uninterruptible);
    yield* Analytics.capture(
      Analytics.Event.StarsImportStarted({
        stars: looked.starredTotal,
        signedIn: policy.paidBy !== undefined,
        mode,
        first: syncedAt === null,
        waitSeconds: Math.ceil(Duration.toSeconds(wait)),
      }),
    ).pipe(Analytics.withActor(actorOf(message)));
    const cost = lookupPaidBy(policy) + (turn === undefined ? 0 : work);
    return { _tag: "Sent", startsAt, cost, fields: { ...looked, syncedAt } } satisfies Sent;
  });

  // The message goes out before the row is scheduled. A crash in between leaves a claimed row, which reads as queued
  // while its job waits in the queue, instead of a login held until starts_at with no job behind it.
  const start = Effect.fn("SyncRequests.start")(function* (login: Login, now: DateTime.Utc, sent: Sent) {
    const { startsAt, cost, fields } = sent;
    yield* db.syncRequests.schedule(login, now, startsAt);
    if (!DateTime.isGreaterThan(startsAt, now)) {
      return { _tag: "Started", cost, status: { state: "queued", requestedAt: now, ...fields } } satisfies Admission;
    }
    const ahead = yield* db.syncRequests.ahead(startsAt, now);
    const status: SyncStatus = { state: "waiting", requestedAt: now, startsAt, ahead, ...fields };
    return { _tag: "Waiting", cost, wait: DateTime.distance(now, startsAt), status } satisfies Admission;
  });

  const admit = Effect.fnUntraced(function* (
    login: Login,
    policy: Policy,
  ): Effect.fn.Return<Admission, SyncRequestError | Refused> {
    const now = yield* DateTime.now;
    const { account, stored, status: current, fullSyncedAt } = yield* read(login, now);
    const cooldown = current.state === "queued" || current.state === "waiting" ? queuedWait : policy.cooldown;
    if (current.state === "done" && within(cooldown, now)(current.syncedAt)) {
      return { _tag: "Deduped", status: current };
    }
    const waitsInLine = policy.paidBy === undefined;
    const takesOver = !waitsInLine && current.state === "waiting";
    const held = takesOver ? Option.none() : Option.filter(stored, holds(cooldown, now));
    if (Option.isSome(held)) {
      return held.value.outcome === "missing" ? { _tag: "NotFound", cost: 0 } : { _tag: "Deduped", status: current };
    }
    if (waitsInLine) {
      const wait = yield* RateLine.wait(db.rateLines, all, now);
      if (Duration.isGreaterThan(wait, all.rate.maxWait)) return { _tag: "LineFull", cost: 0, wait };
    }
    const found: Found =
      policy.network === undefined
        ? { _tag: "User", looked: lookedOf(account) }
        : yield* lookUp(login, RateLine.githubNetwork(policy.network), now);

    // A takeover pays no first read, so a requester whose network pays one takes over only a request it read as
    // waiting. The owner pays none, so their claim takes over whatever waits when it lands.
    const overtakesWaiting = !waitsInLine && (takesOver || policy.network === undefined);

    const claimed = yield* Effect.scoped(
      Effect.gen(function* (): Effect.fn.Return<Admission | Sent, SyncRequestError | Refused, Scope.Scope> {
        const sending = yield* Ref.make(false);
        const outcome = found._tag === "Missing" ? "missing" : "claimed";
        if (!(yield* claim(login, now, { cooldown, overtakesWaiting, outcome }, stoppedBefore(sending)))) {
          return yield* fromWinner(login, now, lookupPaidBy(policy));
        }
        switch (found._tag) {
          case "Missing":
            return { _tag: "NotFound", cost: lookupCost };
          case "Org":
            // The lookup wrote the account, and an org has nothing to send, so its claim records an empty sync now.
            yield* db.accounts
              .recordStarSync({ accountId: found.accountId, at: now })
              .pipe(Effect.catchTags({ AccountNotFound: Effect.die }));
            yield* db.syncRequests.schedule(login, now, now);
            return { _tag: "Org", status: { state: "done", syncedAt: now, ...found.looked } };
          case "User":
            return yield* send(login, now, policy, takesOver, { status: current, fullSyncedAt }, found.looked, sending);
        }
      }),
    );
    return claimed._tag === "Sent" ? yield* start(login, now, claimed) : claimed;
  });

  const request = Effect.fn("SyncRequests.request")(function* (login: Login, by: Requester) {
    const admission = yield* admit(login, policyOf(by)).pipe(
      Effect.catchTags({ Refused: (refused) => Effect.succeed(refused.admission) }),
    );
    return yield* decide(login, admission);
  });

  return SyncRequests.of({ request, status });
});

export const layer = (share: BudgetShare) => Layer.effect(SyncRequests, make(share));
