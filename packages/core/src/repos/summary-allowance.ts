import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as RateLine from "../limits/rate-line.ts";

// The repos the cap refused, and when its line has room again.
export interface Capped<A> {
  readonly repos: Arr.NonEmptyReadonlyArray<A>;
  readonly until: DateTime.Utc;
}

export interface Allowance<A> {
  readonly allowed: ReadonlyArray<A>;
  readonly capped: Option.Option<Capped<A>>;
}

// Answers which repos may have a paid summary call, and counts each one it allows.
export class SummaryAllowance extends Context.Service<
  SummaryAllowance,
  {
    // One unit per repo, in order, until the line refuses one. The rest are refused with it.
    readonly take: <A>(repos: ReadonlyArray<A>) => Effect.Effect<Allowance<A>, DbQueryFailed | DbRowInvalid>;
  }
>()("@stargrep/core/repos/summary-allowance/SummaryAllowance") {}

export const summaryCap = Metric.counter("stargrep_summary_cap", {
  description: "Paid summary calls the daily summary cap allowed or refused, by outcome.",
});

const count = (outcome: "allowed" | "capped", repos: number) =>
  repos === 0 ? Effect.void : Metric.update(Metric.withAttributes(summaryCap, { outcome }), repos);

// Meters summaries in summaryAll, one atomic reservation per repo, so concurrent attempts never share a unit. A line
// that cannot be read fails the attempt, which then holds its leases until they run out, as a run cut short does.
export const layerMetered = Layer.effect(
  SummaryAllowance,
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const take = Effect.fn("SummaryAllowance.take")(function* <A>(repos: ReadonlyArray<A>) {
      const at = yield* DateTime.now;
      let allowed = 0;
      while (allowed < repos.length) {
        const reserved = yield* RateLine.reserve(db.rateLines, RateLine.summaryAll, at, 1);
        if (Option.isNone(reserved)) break;
        allowed++;
      }
      yield* count("allowed", allowed);
      const refused = repos.slice(allowed);
      if (!Arr.isReadonlyArrayNonEmpty(refused)) return { allowed: repos, capped: Option.none() };
      const until = DateTime.addDuration(at, yield* RateLine.wait(db.rateLines, RateLine.summaryAll, at));
      yield* count("capped", refused.length);
      yield* Effect.logWarning(`Summary cap reached, ${refused.length} repos waiting`, {
        waiting: refused.length,
        until: DateTime.formatIso(until),
        perDay: RateLine.summariesPerDay,
      });
      return { allowed: repos.slice(0, allowed), capped: Option.some({ repos: refused, until }) };
    });
    return SummaryAllowance.of({ take });
  }),
);

// Lets every summary through, for tools, tests, and stages whose summaries come from the stand-in, which costs nothing.
export const layerUnmetered = Layer.succeed(
  SummaryAllowance,
  SummaryAllowance.of({
    take: Effect.fn("SummaryAllowance.take")(<A>(repos: ReadonlyArray<A>) =>
      Effect.succeed<Allowance<A>>({ allowed: repos, capped: Option.none() }),
    ),
  }),
);
