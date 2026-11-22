import * as Db from "@stargrep/db";
import * as GitHub from "@stargrep/github/github";
import type { BudgetShare } from "@stargrep/github/schemas";
import type * as StarProbe from "@stargrep/github/star-probe";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as RateLine from "../limits/rate-line.ts";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequests from "./sync-requests.ts";

export interface Settings {
  // How long a person on the people list, or anyone someone follows, goes between checks.
  readonly peopleCadence: Duration.Duration;
  // How long any other synced user goes between checks.
  readonly cadence: Duration.Duration;
  // How often the cron runs a check. An account is due once its last check is older than its cadence less this, so it
  // is checked within one cadence of the last.
  readonly every: Duration.Duration;
  // The slice of the token's time and GraphQL points: at most this many accounts a run, one point per batch.
  readonly accountsPerRun: number;
  // The REST slice: at most this many syncs a run, each an incremental read of about two requests.
  readonly syncsPerRun: number;
}

// GitHub answers one account at a time however they are batched, so the check costs the gate's time more than points.
// 354 people hourly and 10,000 other accounts daily come to about 130 accounts a run, about a minute of the gate's time
// and 15 points. Checking every account hourly would hold the gate for most of every hour.
export const settings: Settings = {
  peopleCadence: Duration.hours(1),
  cadence: Duration.days(1),
  every: Duration.minutes(10),
  accountsPerRun: 150,
  syncsPerRun: 50,
};

// GitHub answers a probe's aliases one after another, measured at about 0.17 s for an account with tens of stars,
// 0.3 s for hundreds, and 0.7 s for thousands, and cuts a request off at 10 s. A batch holds accounts up to a weight of
// batchWeight, about 4 s: 24 light accounts, 12 with hundreds of stars, or 6 with thousands. An unknown count is heavy.
const batchWeight = 24;

const weightOf = (account: Db.StarCheckDue) =>
  account.starredCount === null || account.starredCount > 2_000 ? 4 : account.starredCount > 200 ? 2 : 1;

// Packs the accounts in order into batches of at most batchWeight.
export const batches = (accounts: ReadonlyArray<Db.StarCheckDue>) => {
  const packed: Array<Array<Db.StarCheckDue>> = [];
  let weight = batchWeight;
  for (const account of accounts) {
    const next = weightOf(account);
    if (weight + next > batchWeight) {
      packed.push([]);
      weight = 0;
    }
    packed[packed.length - 1]?.push(account);
    weight += next;
  }
  return packed;
};

export type Stop = "done" | "paused" | "failed";

export interface Report {
  readonly due: number;
  readonly current: number;
  readonly synced: number;
  // Accounts with new stars whose sync waits for the next run, because the run's syncs or githubAll had no room.
  readonly deferred: number;
  readonly missing: number;
  readonly points: number;
  // The longest one probe request took, against GitHub's 10 s limit on a query.
  readonly slowestMillis: number;
  readonly stop: Stop;
}

// The probe asked about the account and GitHub lists a star newer than the account's last sync. A starred total that
// moved with no newer star means stars were removed, which only a full read sees, so it records the total and reads
// nothing.
export const hasNewStars = (due: Db.StarCheckDue, probed: StarProbe.Probed) =>
  Option.exists(probed.newestStarredAt, (at) => DateTime.isGreaterThan(at, due.starsSyncedAt));

// A spent budget share, a rate limit, or no token at all pauses the run until the next one.
const pausing = new Set(["TokenBudgetExhausted", "RateLimited", "GitHubTokenMissing"]);

// Checks the due synced users, the oldest check first, one GraphQL request a batch, on the server's token. An account
// with no newer star is marked checked, so stars_checked_at says its stored stars were current then. An account with one
// gets an incremental sync on the server's token, which takes its turn in githubAll only when the line can start it now,
// so a check never makes a signed-out sync wait. It stays unchecked: its sync moves stars_synced_at once it finishes,
// and until then the next run asks again.
export const run = Effect.fn("StarCheck.run")(function* (share: BudgetShare, slice: Settings = settings) {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const queue = yield* SyncQueue.SyncQueue;
  const all = RateLine.githubAll(share);
  // The same line, but a turn starts now or never.
  const allNow: RateLine.Line = { ...all, rate: { ...all.rate, maxWait: Duration.zero } };
  const now = yield* DateTime.now;
  const cutoff = (cadence: Duration.Duration) =>
    DateTime.subtractDuration(now, Duration.subtract(cadence, slice.every));
  const due = yield* db.accounts.dueForStarCheck({
    peopleBefore: cutoff(slice.peopleCadence),
    othersBefore: cutoff(slice.cadence),
    limit: slice.accountsPerRun,
  });
  const report = {
    due: due.length,
    current: 0,
    synced: 0,
    deferred: 0,
    missing: 0,
    points: 0,
    slowestMillis: 0,
    stop: "done" as Stop,
  };

  const syncNow = Effect.fnUntraced(function* (account: Db.StarCheckDue, probed: StarProbe.Probed) {
    if (report.synced >= slice.syncsPerRun) return false;
    const units = SyncRequests.costOf({
      _tag: "since",
      starredTotal: probed.starredTotal,
      storedStars: account.starredCount ?? probed.starredTotal,
    });
    const at = yield* DateTime.now;
    const turn = yield* RateLine.reserve(db.rateLines, allNow, at, units);
    if (Option.isNone(turn)) return false;
    const { endsAt, generation, released } = turn.value;
    yield* queue
      .send(
        { login: account.login, mode: "incremental", reserved: { units, endsAt, generation, released } },
        Duration.zero,
      )
      .pipe(Effect.tapError(() => db.rateLines.release(turn.value, at).pipe(Effect.ignore)));
    return true;
  });

  for (const batch of batches(due)) {
    const started = yield* Clock.currentTimeMillis;
    const answer = yield* Effect.result(github.probeStars(batch));
    report.slowestMillis = Math.max(report.slowestMillis, (yield* Clock.currentTimeMillis) - started);
    if (Result.isFailure(answer)) {
      report.stop = pausing.has(answer.failure._tag) ? "paused" : "failed";
      yield* Effect.logWarning("Star check stopped", { stop: report.stop, error: answer.failure.message });
      break;
    }
    report.points += answer.success.cost;
    report.missing += answer.success.missing.length;
    const byId = new Map(batch.map((account) => [account.id, account]));
    const checks: Array<Db.StarredCount> = [];
    for (const probed of answer.success.probed) {
      const account = byId.get(probed.id);
      if (account === undefined) continue;
      if (!hasNewStars(account, probed)) {
        report.current++;
        checks.push({ accountId: probed.id, starredCount: probed.starredTotal });
      } else if (yield* syncNow(account, probed)) report.synced++;
      else report.deferred++;
    }
    yield* db.accounts.recordStarChecks({ checks, at: now });
  }

  yield* Effect.logInfo("Star check ran", report);
  return report satisfies Report;
});
