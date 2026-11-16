import { expect } from "bun:test";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import * as TestDatabase from "@stargrep/db/test-database";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import * as EnrichQueue from "./enrich-queue.ts";
import { embeddingModel, fixture, id, oid } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";
import * as SummaryAllowance from "./summary-allowance.ts";

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

// The line pays out one unit every 86.4 seconds once a day's units are spent.
const unit = Duration.millis(86_400);

for (const [adapter, database] of adapters) {
  const f = fixture();
  let calls = 0;
  const text = f.textGeneration((request) =>
    Effect.sync(() => {
      calls++;
      return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
    }),
  );
  // The Worker's enrichment: the summary cap metered in the database's rate lines.
  const metered = (ids: ReadonlyArray<RepoId>) =>
    EnrichRepo.EnrichRepo.use((enricher) => enricher.enrichRepos(ids)).pipe(
      Effect.provide(
        Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(text, SummaryAllowance.layerMetered))),
      ),
    );
  const swept = Effect.gen(function* () {
    const queue = EnrichQueue.layerMemory();
    yield* EnrichRetry.sweep().pipe(Effect.provide(queue.layer));
    return queue.sent.map((message) => Number(message.repoId));
  });
  const retryAt = (n: number) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) =>
      test.query(
        "select to_char(enrich_retry_at at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.MS') as at from repos where id = $1",
        [n],
      ),
    );
  // Spends units of the day's cap, as summaries before the test would have.
  const spend = Effect.fn("test.spend")(function* (units: number) {
    const db = yield* Db.Db;
    const reserved = yield* RateLine.reserve(db.rateLines, RateLine.summaryAll, yield* DateTime.now, units);
    expect(Option.isSome(reserved)).toBe(true);
  });
  const seed = (numbers: ReadonlyArray<number>) => {
    for (const n of numbers) f.remotes.set(n, { description: `Repo ${n}`, readme: { oid: oid("c"), text: "# Repo" } });
    return f.store(numbers);
  };

  it.layer(f.enrichment(database), { timeout: 30_000 })(`daily summary cap on ${adapter}`, (it) => {
    it.effect("defers the 1,001st summary of a day until the cap has room, counting nothing, then summarizes it", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-05T00:00:00Z"));
        yield* spend(RateLine.summariesPerDay - 1);
        calls = 0;
        const ids = yield* seed([1101, 1102]);

        const first = yield* metered(ids);
        expect(first.map((outcome) => outcome._tag)).toEqual(["Summarized", "Capped"]);
        expect(calls).toBe(1);
        expect(yield* f.failuresOf(1102)).toEqual([{ enrich_failures: 0 }]);
        expect(yield* retryAt(1102)).toEqual([{ at: "2026-11-05 00:01:26.400" }]);
        expect(yield* swept).toEqual([]);

        yield* TestClock.adjust(unit);
        expect(yield* swept).toEqual([1102]);
        const second = yield* metered([id(1102)]);
        expect(second.map((outcome) => outcome._tag)).toEqual(["Summarized"]);
        expect(calls).toBe(2);
        expect(yield* f.failuresOf(1102)).toEqual([{ enrich_failures: 0 }]);
      }),
    );

    it.effect("takes a unit for the new summary a recipe change asks for, and none for an embedding", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-12-05T00:00:00Z"));
        yield* seed([1201, 1202]);
        expect((yield* f.enrich(1201))._tag).toBe("Summarized");
        expect((yield* f.enrich(1202))._tag).toBe("Summarized");
        yield* Effect.flatMap(TestDatabase.TestDatabase, (test) =>
          test.query("update repos set summary_recipe = summary_recipe - 1 where id = $1", [1201]),
        );
        yield* f.resummarize(1202);
        yield* spend(RateLine.summariesPerDay);
        calls = 0;

        const outcomes = yield* metered([id(1201), id(1202)]);
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Capped", "Embedded"]);
        expect(calls).toBe(0);

        yield* TestClock.adjust(unit);
        expect((yield* metered([id(1201)])).map((outcome) => outcome._tag)).toEqual(["Summarized"]);
        expect(calls).toBe(1);
      }),
    );

    it.effect("warns once for every repo one attempt defers, and counts each repo", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2027-01-05T00:00:00Z"));
        yield* spend(RateLine.summariesPerDay - 1);
        const ids = yield* seed([1301, 1302, 1303, 1304]);
        const counted = (outcome: "allowed" | "capped") =>
          Effect.map(
            Metric.value(Metric.withAttributes(SummaryAllowance.summaryCap, { outcome })),
            (state) => state.count,
          );
        const before = { allowed: yield* counted("allowed"), capped: yield* counted("capped") };
        const warnings: Array<unknown> = [];
        const logger = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push((message as ReadonlyArray<unknown>)[0]);
          }),
        ]);

        const outcomes = yield* metered(ids).pipe(Effect.provide(logger));
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Summarized", "Capped", "Capped", "Capped"]);
        expect(warnings).toEqual(["Summary cap reached, 3 repos waiting"]);
        expect({
          allowed: (yield* counted("allowed")) - before.allowed,
          capped: (yield* counted("capped")) - before.capped,
        }).toEqual({ allowed: 1, capped: 3 });
      }),
    );
  });
}
