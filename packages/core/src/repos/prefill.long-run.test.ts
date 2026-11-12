import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import {
  adapters,
  askedFor,
  fixture,
  query,
  range,
  ref,
  run,
  runWith,
  tally,
  unjittered,
  watchLogs,
} from "./prefill.fixture.ts";
import * as Prefill from "./prefill.ts";

// What a prefill that runs for days on a laptop must survive without stopping or paying twice: a lost connection, a
// laptop waking from sleep, a flaky README cache, and CLI calls that crash or run out of subscription.

const quiet = { resumed: 0, dropped: 0, created: 0, closed: 0, fallbacks: 0, stuck: [] };

for (const [adapter, database] of adapters) {
  const f = fixture();
  const fresh = <ROut, E>(replacing: Layer.Layer<ROut, E>, logs: Layer.Layer<never> = Layer.empty) =>
    Effect.provide(Layer.merge(Layer.fresh(Prefill.layer).pipe(Layer.provide(replacing)), logs));
  // A Db whose summarized read fails as a lost connection or a bad query would, before it reaches the database.
  const summarizedFails = (db: Db.Db["Service"], failures: number, reason: "transport" | "query") => {
    const attempts = { count: 0 };
    const layer = Layer.succeed(
      Db.Db,
      Db.Db.of({
        ...db,
        repos: {
          ...db.repos,
          summarized: (ids, askCurrent) =>
            attempts.count++ < failures
              ? Effect.fail(new DbQueryFailed({ operation: "repos.summarized", reason, sqlState: null }))
              : db.repos.summarized(ids, askCurrent),
        },
      }),
    );
    return { layer, attempts };
  };
  const leasedBy = (ids: ReadonlyArray<number>) =>
    query(
      `select count(*)::int as count from repos r join extraction_batches b on r.id = any(b.repo_ids)
       where r.id = any($1::bigint[]) and r.enrich_retry_at = b.lease_until and b.state in ('prepared', 'submitted')`,
      [ids],
    ).pipe(Effect.map((rows) => (rows[0] as { count: number }).count));

  it.layer(f.layer(database), { timeout: 60_000, testTimeout: 60_000 })(`prefill long run on ${adapter}`, (it) => {
    it.effect("tries a chunk again after a lost connection, and prefills every repo", () =>
      Effect.gen(function* () {
        f.seed([7001, 7002]);
        const lost = summarizedFails(yield* Db.Db, 1, "transport");
        const logs = yield* watchLogs;
        const running = yield* Effect.forkChild(
          run([ref(7001), ref(7002)]).pipe(fresh(lost.layer, logs.layer), unjittered),
        );
        yield* logs.retrying;
        yield* TestClock.adjust("5 seconds");
        const report = yield* Fiber.join(running);
        expect(tally(report)).toEqual({ saved: 2 });
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 1 });
        expect(lost.attempts.count).toBe(2);
      }),
    );

    it.effect("gives up on a chunk after about a quarter of an hour of failures that can pass", () =>
      Effect.gen(function* () {
        f.seed([7101]);
        const lost = summarizedFails(yield* Db.Db, Number.POSITIVE_INFINITY, "transport");
        const logs = yield* watchLogs;
        const running = yield* Effect.forkChild(
          Effect.flip(run([ref(7101)]).pipe(fresh(lost.layer, logs.layer), unjittered)),
        );
        // Five seconds doubling, at most five minutes.
        for (const seconds of [5, 10, 20, 40, 80, 160, 300, 300]) {
          yield* logs.retrying;
          yield* TestClock.adjust(`${seconds} seconds`);
        }
        yield* logs.retrying;
        const failed = yield* Fiber.join(running);
        expect([failed._tag, failed._tag === "DbQueryFailed" && failed.reason]).toEqual(["DbQueryFailed", "transport"]);
        expect(lost.attempts.count).toBe(9);
      }),
    );

    it.effect("stops at once on a failure that would repeat, such as a query the database refuses", () =>
      Effect.gen(function* () {
        f.seed([7201]);
        const broken = summarizedFails(yield* Db.Db, Number.POSITIVE_INFINITY, "query");
        const failed = yield* Effect.flip(run([ref(7201)]).pipe(fresh(broken.layer)));
        expect([failed._tag, failed._tag === "DbQueryFailed" && failed.reason]).toEqual(["DbQueryFailed", "query"]);
        expect(broken.attempts.count).toBe(1);
      }),
    );

    it.effect("resumes a manifest that failed to settle within the run, and pays for its batch once", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.seed([7301, 7302]);
        const submitted = f.batches.submissions.length;
        const paid = f.batches.paid.length;
        let failures = 1;
        const lost = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              submittedBatch: (batch) =>
                failures-- > 0
                  ? Effect.fail(
                      new DbQueryFailed({ operation: "knowledge.submittedBatch", reason: "transport", sqlState: null }),
                    )
                  : db.knowledge.submittedBatch(batch),
            },
          }),
        );
        const report = yield* run([ref(7301), ref(7302)]).pipe(fresh(lost));
        expect(tally(report)).toEqual({ saved: 2 });
        expect(report.manifests).toEqual({ ...quiet, created: 1, resumed: 1, closed: 1 });
        expect(f.batches.submissions.slice(submitted).map((submission) => submission.replayed)).toEqual([false, true]);
        expect(f.batches.paid.length - paid).toBe(2);
      }),
    );

    it.effect("reads each README from GitHub when the README cache fails, and prefills its repos", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        f.seed([7401, 7402]);
        const readmeReads = () => f.github.sent.filter((sent) => sent.url.pathname.includes("/git/blobs/")).length;
        const before = readmeReads();
        const flaky = Layer.succeed(
          BlobStore.BlobStore,
          BlobStore.BlobStore.of({
            get: (key) =>
              key.startsWith("readmes/")
                ? Effect.fail(new BlobStore.BlobStoreFailed({ operation: "get", key, cause: null }))
                : blobs.get(key),
            put: (key, value) =>
              key.startsWith("readmes/")
                ? Effect.fail(new BlobStore.BlobStoreFailed({ operation: "put", key, cause: null }))
                : blobs.put(key, value),
          }),
        );
        const report = yield* run([ref(7401), ref(7402)]).pipe(fresh(flaky));
        expect(tally(report)).toEqual({ saved: 2 });
        expect(readmeReads() - before).toBe(2);
      }),
    );

    it.effect("asks a CLI item whose call failed again in a fallback manifest, and settles a second failure", () =>
      Effect.gen(function* () {
        f.seed([7501, 7502, 7503]);
        f.failing.once.add(7501);
        f.failing.always.add(7502);
        const report = yield* runWith([ref(7501), ref(7502), ref(7503)], { adapter: "claude-code" });
        f.failing.always.delete(7502);
        expect(tally(report)).toEqual({ saved: 2, failed: 1 });
        expect(report.retried.map(Number).toSorted()).toEqual([7501, 7502]);
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 2, fallbacks: 1 });
        expect(askedFor(f.asked, [7501, 7502, 7503]).length).toBe(5);
        expect(
          yield* query(
            `select retry_of is not null as fallback, state, cardinality(repo_ids)::int as items,
               array(select unnest(failed_repo_ids)::int) as failed
             from extraction_batches where 7502 = any(repo_ids) order by retry_of nulls first`,
          ),
        ).toEqual([
          { fallback: false, state: "captured", items: 3, failed: [] },
          { fallback: true, state: "captured", items: 2, failed: [7502] },
        ]);
        // A crashed CLI is no fault of the repo's, so its lease is given back uncounted, as enrichment settles it.
        expect(
          yield* query(
            `select r.id::int as id, r.enrich_failures as failures, r.enrich_retry_at is null as free, c.model
             from repos r left join receipts c on c.id = r.receipt_id where r.id between 7501 and 7503 order by r.id`,
          ),
        ).toEqual([
          { id: 7501, failures: 0, free: true, model: "fake/summary" },
          { id: 7502, failures: 0, free: true, model: null },
          { id: 7503, failures: 0, free: true, model: "fake/summary" },
        ]);
      }),
    );

    // The live run stopped this way: a resumed fallback full of repos Haiku refuses, such as remote access trojans.
    it.effect("caps sixty refused CLI items without a fallback, and never stops the run for them", () =>
      Effect.gen(function* () {
        const ids = range(7701, 60);
        f.seed(ids);
        for (const n of ids) f.refusing.add(n);
        const report = yield* runWith(ids.map(ref), { adapter: "claude-code" });
        for (const n of ids) f.refusing.delete(n);
        expect(tally(report)).toEqual({ failed: ids.length });
        expect(report.retried).toEqual([]);
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 1 });
        expect(askedFor(f.asked, ids).length).toBe(ids.length);
        expect(
          yield* query(
            `select count(*)::int as capped from repos
             where id = any($1::bigint[]) and enrich_failures = $2 and enrich_retry_at is null`,
            [ids, Db.enrichFailureCap],
          ),
        ).toEqual([{ capped: ids.length }]);
      }),
    );

    it.effect("stops when the model fails fifty calls in a row, keeping every lease for a rerun", () =>
      Effect.gen(function* () {
        const ids = range(7601, 60);
        f.seed(ids);
        for (const n of ids) f.failing.always.add(n);
        const failed = yield* Effect.flip(runWith(ids.map(ref), { adapter: "claude-code" }));
        expect(failed._tag).toBe("ModelUnavailable");
        expect(askedFor(f.asked, ids).length).toBeLessThan(ids.length);
        expect(yield* leasedBy(ids)).toBe(ids.length);
        expect(
          yield* query(
            "select count(*)::int as counted from repos where id = any($1::bigint[]) and enrich_failures > 0",
            [ids],
          ),
        ).toEqual([{ counted: 0 }]);

        for (const n of ids) f.failing.always.delete(n);
        const rerun = yield* runWith(ids.map(ref), { adapter: "claude-code" });
        expect(tally(rerun)).toEqual({ saved: ids.length });
        expect(rerun.manifests).toEqual({ ...quiet, resumed: 1, closed: 1 });
      }),
    );
  });
}
