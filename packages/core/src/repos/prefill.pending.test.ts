import { expect } from "bun:test";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { RepoId, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { adapters, fixture, query, range, ref, run, runWith, sweepAndConsume, tally } from "./prefill.fixture.ts";
import * as Prefill from "./prefill.ts";

// prefill --pending clears the backlog the Worker's daily summary cap leaves, with the Claude Code CLI on a developer's
// machine, against the same database the Worker's sweep reads.

const store = (numbers: ReadonlyArray<number>) =>
  Effect.flatMap(Db.Db, (db) =>
    db.repos.upsertRefs(numbers.map((n) => ({ ...ref(n), nodeId: RepoNodeId.make(`R_${n}`) }))),
  );

// The units the Worker's summary line owes at this time, one per summary it allowed.
const unitsOwed = (at: DateTime.Utc) =>
  query(
    `select round(extract(epoch from (busy_until - $1::timestamptz)) * 1000 / 86400)::int as units
     from rate_lines where key = 'summary/all'`,
    [DateTime.formatIso(at)],
  );

for (const [adapter, database] of adapters) {
  const f = fixture();

  it.layer(f.layer(database), { timeout: 60_000 })(`prefill of the Worker's backlog on ${adapter}`, (it) => {
    it.effect("selects pending repos with no current summary that no attempt holds, in the sweep's order", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* query("truncate repos cascade");
        yield* TestClock.setTime(Date.parse("2026-11-05T00:00:00Z"));
        const now = yield* DateTime.now;
        const [fresh, held, failedOnce, capped, read, oldRecipe, gone, movedReadme] = [
          RepoId.make(3001),
          RepoId.make(3002),
          RepoId.make(3003),
          RepoId.make(3004),
          RepoId.make(3005),
          RepoId.make(3006),
          RepoId.make(3007),
          RepoId.make(3008),
        ];
        f.seed(range(3001, 8));
        yield* run([ref(read), ref(movedReadme)]);
        yield* store([fresh, held, failedOnce, capped, oldRecipe, gone]);
        yield* run([ref(oldRecipe)]);
        yield* query("update repos set summary_recipe = summary_recipe - 1 where id = $1", [oldRecipe]);
        yield* query("update repos set readme_oid = repeat('d', 40) where id = $1", [movedReadme]);
        yield* query("update repos set gone_at = now() where id = $1", [gone]);
        yield* query("update repos set enrich_failures = $2 where id = $1", [capped, Db.enrichFailureCap]);
        yield* query("update repos set enrich_failures = 1, enrich_retry_at = $2::timestamptz where id = $1", [
          failedOnce,
          "2026-11-04T23:00:00Z",
        ]);
        expect(yield* db.repos.lease({ ids: [held], now, until: DateTime.add(now, { minutes: 15 }) })).toEqual([held]);

        const backlog = yield* Prefill.backlog(10);
        expect(backlog.waiting).toBe(5);
        expect(backlog.refs.map((repo) => repo.id)).toEqual([failedOnce, fresh, oldRecipe]);
        expect((yield* Prefill.backlog(2)).refs.map((repo) => repo.id)).toEqual([failedOnce, fresh]);

        // The Worker leases fresh after the selection, so the run finds it held and asks only the other two.
        expect(yield* db.repos.lease({ ids: [fresh], now, until: DateTime.add(now, { minutes: 15 }) })).toEqual([
          fresh,
        ]);
        const report = yield* runWith(backlog.refs, { adapter: "claude-code" });
        expect(tally(report)).toEqual({ saved: 2, held: 1 });
        expect(report.outcomes.get(fresh)).toBe("held");
      }),
    );

    it.effect("leases what it asks, so the sweep skips it, and takes nothing from the Worker's summary cap", () =>
      Effect.gen(function* () {
        yield* query("truncate repos cascade");
        yield* TestClock.setTime(Date.parse("2026-12-05T00:00:00Z"));
        const now = yield* DateTime.now;
        const ids = range(3101, 4);
        f.seed(ids);
        yield* store(ids);
        const { waiting, refs } = yield* Prefill.backlog(3);
        expect({ waiting, asking: refs.map((repo) => Number(repo.id)) }).toEqual({
          waiting: 4,
          asking: ids.slice(0, 3),
        });

        const asking = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const cli = Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.make({
            provider: "claude-code",
            model: "claude-code/test",
            timeout: Duration.minutes(5),
            run: (request) =>
              Deferred.succeed(asking, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.as({
                  output: SummarizeFake.respond(request.prompt),
                  usage: { inputTokens: 1, outputTokens: 1 },
                }),
              ),
          }),
        );
        const running = yield* runWith(refs, { adapter: "claude-code" }).pipe(
          Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(cli))),
          Effect.forkChild,
        );
        yield* Deferred.await(asking);
        expect(yield* sweepAndConsume).toEqual([3104]);
        yield* Deferred.succeed(answer, undefined);
        expect(tally(yield* Fiber.join(running))).toEqual({ saved: 3 });

        expect(
          yield* query("select count(*)::int as read from repos where id = any($1) and embedding is not null", [ids]),
        ).toEqual([{ read: 4 }]);
        expect(yield* unitsOwed(now)).toEqual([{ units: 1 }]);
      }),
    );
  });
}
