import * as Db from "@stargrep/db";
import type { BudgetShare } from "@stargrep/github/schemas";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

// A rate line pays out `units` every `per`. On a clear line, `burst` one-unit reservations start at once, so a
// reservation starts while the line owes at most burst less one unit. A heavier reservation starts on the same terms
// and can leave the line owing more than its burst. A reservation that would start later than maxWait from now is
// refused.
export interface Rate {
  readonly units: number;
  readonly per: Duration.Duration;
  readonly burst: number;
  readonly maxWait: Duration.Duration;
}

export interface Line {
  readonly key: Db.LineKey;
  readonly rate: Rate;
}

// GitHub allows the server's token 5,000 REST requests an hour, and the gate lets Stargrep spend its budget share of
// them. Signed-out syncs together take turns in this line, which pays out 80% of that share and leaves the rest to
// enrichment. A signed-in user's sync pays into it only for the requests that fell back to the server's token.
export const githubAll = (share: BudgetShare): Line => ({
  key: Db.LineKey.make("all"),
  rate: { units: 0.8 * share * 5_000, per: Duration.hours(1), burst: 200, maxWait: Duration.hours(2) },
});

// Each network pays a line of its own for every lookup it asks for and for the first read of a login that never synced,
// so one network can neither look logins up without end nor fill githubAll.
export const githubNetwork = (caller: Db.CallerKey): Line => ({
  key: Db.LineKey.make(`caller/${caller}`),
  rate: { units: 150, per: Duration.hours(1), burst: 150, maxWait: Duration.zero },
});

// Planner and query embedding calls count one each. A planner call costs about $0.0004, so one network spends at most
// about $0.73 an hour on plans, and everyone together about $2.40.
export const modelNetwork = (caller: Db.CallerKey): Line => ({
  key: Db.LineKey.make(`model/${caller}`),
  rate: { units: 30, per: Duration.minutes(1), burst: 30, maxWait: Duration.zero },
});

export const modelAll: Line = {
  key: Db.LineKey.make("model/all"),
  rate: { units: 6_000, per: Duration.hours(1), burst: 600, maxWait: Duration.zero },
};

// How long the rate takes to pay out this many units.
export const durationOf = (rate: Rate, units: number) =>
  Duration.millis((units * Duration.toMillis(rate.per)) / rate.units);

const tolerance = (rate: Rate) => durationOf(rate, rate.burst - 1);

type RateLines = Db.Db["Service"]["rateLines"];

// When a reservation of this many units starts, or none when it would wait past maxWait. A forced reservation never
// refuses, for work that pays into the line whatever happens.
export const reserve = (lines: RateLines, line: Line, at: DateTime.Utc, units: number, force = false) =>
  lines.reserve({
    line: line.key,
    at,
    cost: durationOf(line.rate, units),
    tolerance: tolerance(line.rate),
    maxWait: line.rate.maxWait,
    force,
  });

// How long a reservation made at this time would wait.
export const wait = (lines: RateLines, line: Line, at: DateTime.Utc) => lines.wait(line.key, at, tolerance(line.rate));

// Moves the line by a signed number of units: later to bill what work spent, earlier to give back what it did not.
export const bill = (lines: RateLines, line: Line, at: DateTime.Utc, units: number) =>
  lines.adjust(line.key, at, durationOf(line.rate, units));
