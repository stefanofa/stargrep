import { expect } from "bun:test";
import * as Batches from "@stargrep/ai/batches";
import { AiRequestFailed } from "@stargrep/ai/errors";
import * as Db from "@stargrep/db";
import * as it from "@stargrep/testing";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import {
  adapters,
  askedFor,
  fixture,
  killedAtCapture,
  query,
  range,
  ref,
  run,
  runWith,
  sweepAndConsume,
  tally,
} from "./prefill.fixture.ts";
import * as Prefill from "./prefill.ts";

// The failures a resumable prefill must survive without paying twice: a provider that errs or forgets, a request
// object that is lost or changed, a crash between a fallback's answer and its capture, a second driver, and a wait
// that outlasts the lease.

for (const [adapter, database] of adapters) {
  const f = fixture();
  const fresh = <ROut, E>(replacing: Layer.Layer<ROut, E>) =>
    Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(replacing)));
  const manifestOf = (n: number) =>
    query(
      `select id, state, provider_batch_id is not null as sent, request_object as object from extraction_batches
       where $1 = any(repo_ids) and retry_of is null`,
      [n],
    ).pipe(Effect.map((rows) => rows[0] as { id: string; state: string; sent: boolean; object: string }));
  const leased = (ids: ReadonlyArray<number>) =>
    query(
      `select count(*)::int as count from repos r join extraction_batches b on r.id = any(b.repo_ids)
       where r.id = any($1::bigint[]) and r.enrich_retry_at = b.lease_until and b.state in ('prepared', 'submitted')`,
      [ids],
    ).pipe(Effect.map((rows) => (rows[0] as { count: number }).count));

  it.layer(f.layer(database), { timeout: 60_000, testTimeout: 60_000 })(`prefill recovery on ${adapter}`, (it) => {
    it.effect("keeps a batch open when collecting it fails, asks nothing again, and collects it next run", () =>
      Effect.gen(function* () {
        const ids = range(6001, 5);
        f.seed(ids);
        const paidBefore = f.batches.paid.length;
        const submittedBefore = f.batches.submissions.length;
        f.batches.control.collecting = () =>
          Effect.fail(
            new AiRequestFailed({
              operation: "generate",
              model: "fake/summary",
              detail: "GatewayAuthenticationError with status 401",
            }),
          );
        const first = yield* run(ids.map(ref));
        expect(tally(first)).toEqual({ waiting: 5 });
        expect(first.retried).toEqual([]);
        expect(askedFor(f.asked, ids)).toEqual([]);
        expect(yield* manifestOf(6001)).toMatchObject({ state: "submitted", sent: true });
        expect(yield* leased(ids)).toBe(5);
        // The resume reads the recorded batch, which fails the same way, and still asks nothing again.
        const again = yield* run(ids.map(ref));
        f.batches.control.collecting = undefined;
        expect(tally(again)).toEqual({ waiting: 5 });
        expect(again.manifests).toMatchObject({ resumed: 1, fallbacks: 0 });
        expect(yield* leased(ids)).toBe(5);

        const second = yield* run(ids.map(ref));
        expect(tally(second)).toEqual({ saved: 5 });
        expect(second.repaid).toBe(0);
        expect(f.batches.paid.length - paidBefore).toBe(5);
        expect(f.batches.submissions.length - submittedBefore).toBe(1);
      }),
    );

    it.effect("keeps a sent manifest whose request object is lost, with its leases, until the object is back", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        const ids = range(7001, 5);
        f.seed(ids);
        const paidBefore = f.batches.paid.length;
        yield* killedAtCapture(ids.map(ref), 1);
        expect(yield* manifestOf(7001)).toMatchObject({ state: "submitted", sent: true });
        const lost = Layer.succeed(
          BlobStore.BlobStore,
          BlobStore.BlobStore.of({
            get: (key) => (key.startsWith("prefill/") ? Effect.succeedNone : blobs.get(key)),
            put: blobs.put,
          }),
        );
        const without = yield* run(ids.map(ref)).pipe(fresh(lost));
        expect(
          without.manifests.stuck.map(({ reason, providerBatchId }) => [reason, providerBatchId !== null]),
        ).toEqual([["missing", true]]);
        expect(tally(without)).toEqual({ waiting: 5 });
        expect(yield* manifestOf(7001)).toMatchObject({ state: "submitted", sent: true });
        expect(yield* leased(ids)).toBe(5);
        expect((yield* sweepAndConsume).filter((n) => ids.includes(n))).toEqual([]);
        expect(askedFor(f.asked, ids)).toEqual([]);

        const restored = yield* run(ids.map(ref));
        expect(tally(restored)).toEqual({ saved: 5 });
        expect(f.batches.paid.length - paidBefore).toBe(5);
      }),
    );

    it.effect("never sends a stored request that no longer hashes to its manifest's key", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        const ids = range(7101, 3);
        f.seed(ids);
        const submittedBefore = f.batches.submissions.length;
        yield* killedAtCapture(ids.map(ref), 1);
        const { object } = yield* manifestOf(7101);
        const original = Option.getOrThrow(yield* blobs.get(object));
        yield* blobs.put(object, original.replace("A CLI for task 7101", "A CLI for task 7101!"));
        const changed = yield* run(ids.map(ref));
        expect(changed.manifests.stuck).toHaveLength(1);
        expect(tally(changed)).toEqual({ waiting: 3 });
        expect(yield* leased(ids)).toBe(3);

        yield* blobs.put(object, original);
        const restored = yield* run(ids.map(ref));
        expect(tally(restored)).toEqual({ saved: 3 });
        expect(f.batches.submissions.length - submittedBefore).toBe(1);
      }),
    );

    it.effect("reruns a chunk whose batch and fallback both failed, reopening its manifest under the same key", () =>
      Effect.gen(function* () {
        const ids = range(8001, 3);
        f.seed(ids);
        f.batches.control.collecting = () =>
          Effect.succeed(Batches.Collected.Failed({ detail: "batch failed with invalid_batch" }));
        const first = yield* run(ids.map(ref));
        f.batches.control.collecting = undefined;
        expect(tally(first)).toEqual({ failed: 3 });
        expect(first.manifests).toMatchObject({ created: 1, fallbacks: 1, closed: 2 });
        expect(yield* leased(ids)).toBe(0);
        const { id } = yield* manifestOf(8001);

        const second = yield* run(ids.map(ref));
        expect(tally(second)).toEqual({ saved: 3 });
        expect(yield* manifestOf(8001)).toMatchObject({ id, state: "captured" });
      }),
    );

    it.effect("resumes from the recorded batch when the provider has forgotten the request's key", () =>
      Effect.gen(function* () {
        const ids = range(8501, 4);
        f.seed(ids);
        yield* killedAtCapture(ids.map(ref), 1);
        const paidBefore = f.batches.paid.length;
        const submittedBefore = f.batches.submissions.length;
        f.batches.forgetKeys();
        const resumed = yield* run(ids.map(ref));
        expect(tally(resumed)).toEqual({ saved: 4 });
        expect(resumed.repaid).toBe(0);
        expect(f.batches.paid.length - paidBefore).toBe(0);
        expect(f.batches.submissions.length - submittedBefore).toBe(0);
      }),
    );

    it.effect("keeps a recorded batch the provider says it does not know, and resends it only when told to", () =>
      Effect.gen(function* () {
        const ids = range(8601, 3);
        f.seed(ids);
        yield* killedAtCapture(ids.map(ref), 1);
        const { id, object } = yield* manifestOf(8601);
        const [recorded] = (yield* query("select provider_batch_id as batch from extraction_batches where id = $1", [
          id,
        ])) as Array<{ batch: string }>;
        f.batches.forgetKeys();
        f.batches.control.collecting = (batchId) =>
          batchId === recorded?.batch ? Effect.succeed(Batches.Collected.Unknown({ batchId })) : undefined;
        const paidBefore = f.batches.paid.length;
        const kept = yield* run(ids.map(ref));
        expect(tally(kept)).toEqual({ waiting: 3 });
        expect(
          kept.manifests.stuck.map(({ reason, providerBatchId, requestObject }) => [
            reason,
            providerBatchId,
            requestObject,
          ]),
        ).toEqual([["unknown-batch", recorded?.batch ?? null, object]]);
        expect(f.batches.paid.length - paidBefore).toBe(0);
        expect(yield* leased(ids)).toBe(3);

        const resent = yield* runWith(ids.map(ref), { resendUnknown: true });
        f.batches.control.collecting = undefined;
        expect(tally(resent)).toEqual({ saved: 3 });
        expect(resent.repaid).toBe(3);
      }),
    );

    it.effect("resumes a fallback batch a crash interrupted, so its items are paid for once", () =>
      Effect.gen(function* () {
        const ids = [9301, 9302];
        f.seed(ids);
        for (const n of ids) f.broken.once.add(n);
        const paidBefore = f.batches.paid.length;
        yield* killedAtCapture(ids.map(ref), 1);
        expect(f.batches.paid.length - paidBefore).toBe(4);
        const resumed = yield* run(ids.map(ref));
        expect(tally(resumed)).toEqual({ saved: 2 });
        expect(resumed.repaid).toBe(0);
        expect(f.batches.paid.length - paidBefore).toBe(4);
        expect(askedFor(f.asked, ids)).toEqual([]);
        expect(
          yield* query("select count(*)::int as receipts from receipts where repo_id = any($1::bigint[])", [ids]),
        ).toEqual([{ receipts: 2 }]);
      }),
    );

    it.effect("refuses a second driver while one holds the prefill, so it cannot touch the first one's manifest", () =>
      Effect.gen(function* () {
        const batches = yield* Batches.Batches;
        const ids = [9451, 9452];
        f.seed(ids);
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const slowSend = Layer.succeed(
          Batches.Batches,
          Batches.Batches.of({
            ...batches,
            submit: (request) =>
              Deferred.succeed(paused, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(batches.submit(request)),
              ),
          }),
        );
        const first = yield* run(ids.map(ref)).pipe(fresh(slowSend), Effect.forkChild);
        yield* Deferred.await(paused);
        const other = yield* Effect.flip(run([]));
        expect(other._tag).toBe("PrefillBusy");
        // A driver whose clock runs ten minutes ahead still sees the first one's heartbeat as fresh, because the
        // database's clock dates every heartbeat and judges its age.
        const clock = yield* Clock.Clock;
        const ahead = Duration.toMillis(Duration.minutes(10));
        const skewed: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ahead,
          currentTimeMillis: Effect.map(clock.currentTimeMillis, (millis) => millis + ahead),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ahead) * 1_000_000n,
          currentTimeNanos: Effect.map(clock.currentTimeNanos, (nanos) => nanos + BigInt(ahead) * 1_000_000n),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        };
        const skewedOther = yield* Effect.flip(run([]).pipe(Effect.provideService(Clock.Clock, skewed)));
        expect(skewedOther._tag).toBe("PrefillBusy");
        yield* Deferred.succeed(release, undefined);
        expect(tally(yield* Fiber.join(first))).toEqual({ saved: 2 });
        expect(
          yield* query("select count(*)::int as receipts from receipts where repo_id = any($1::bigint[])", [ids]),
        ).toEqual([{ receipts: 2 }]);
      }),
    );

    it.effect("keeps its repos leased through a 27-hour wait, and leaves the batch open at the deadline", () =>
      Effect.gen(function* () {
        const ids = [9601, 9602];
        f.seed(ids);
        const paused = yield* Deferred.make<void>();
        f.batches.control.collecting = () => Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never));
        const first = yield* Effect.forkChild(run(ids.map(ref)));
        yield* Deferred.await(paused);
        // Each hour of the wait the driver renews the lease. The test waits for each renewal to land before it moves the
        // clock again, since a query still in flight when the clock jumps would hit its timeout.
        const leaseOf = query(
          "select (extract(epoch from lease_until) * 1000)::float8 as at from extraction_batches where $1 = any(repo_ids)",
          [ids[0]],
        ).pipe(Effect.map((rows) => (rows[0] as { at: number }).at));
        for (let hour = 1; hour <= 27; hour++) {
          yield* TestClock.adjust("1 hour");
          if (hour >= 25) continue;
          const renewedBy = (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.hours(25));
          yield* leaseOf.pipe(Effect.repeat({ until: (at) => at > renewedBy, times: 500 }));
        }
        expect((yield* sweepAndConsume).filter((n) => ids.includes(n))).toEqual([]);
        expect(askedFor(f.asked, ids)).toEqual([]);
        expect(tally(yield* Fiber.join(first))).toEqual({ waiting: 2 });
        expect(yield* leased(ids)).toBe(2);
        f.batches.control.collecting = undefined;
        expect(tally(yield* run(ids.map(ref)))).toEqual({ saved: 2 });
      }),
    );

    it.effect("captures a resumed manifest under the recipe and model it was asked with", () =>
      Effect.gen(function* () {
        const ids = [9501, 9502];
        f.seed(ids);
        yield* killedAtCapture(ids.map(ref), 1);
        yield* query("update extraction_batches set recipe = 1 where $1 = any(repo_ids)", [9501]);
        const batches = yield* Batches.Batches;
        const nextModel = Layer.succeed(
          Batches.Batches,
          Batches.Batches.of({ ...batches, model: "fake/summary-next" }),
        );
        const { id } = yield* manifestOf(9501);
        yield* run(ids.map(ref)).pipe(fresh(nextModel));
        // The resumed answers are history under the recipe and model that asked them, so the same run asks both repos
        // again under the current recipe.
        expect(
          yield* query(
            `select c.recipe, c.model, c.batch_id = $2 as resumed from receipts c
             where c.repo_id = any($1::bigint[]) order by c.batch_id = $2 desc, c.repo_id`,
            [ids, id],
          ),
        ).toEqual([
          { recipe: 1, model: "fake/summary", resumed: true },
          { recipe: 1, model: "fake/summary", resumed: true },
          { recipe: 2, model: "fake/summary-next", resumed: false },
          { recipe: 2, model: "fake/summary-next", resumed: false },
        ]);
        expect(yield* query(`select summary_recipe as recipe from repos where id = any($1::bigint[])`, [ids])).toEqual([
          { recipe: 2 },
          { recipe: 2 },
        ]);
      }),
    );

    // A driver that commits its manifest and stalls, while another takes over, leaves a manifest the other resumes
    // rather than drops, since its request object was stored before the commit.
    it.effect("never drops a stalled driver's manifest, so its batch is paid for once", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const blobs = yield* BlobStore.BlobStore;
        const ids = range(9651, 2);
        f.seed(ids);
        const paidBefore = f.batches.paid.length;
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const stalled = Layer.mergeAll(
          Layer.succeed(
            BlobStore.BlobStore,
            BlobStore.BlobStore.of({
              get: blobs.get,
              put: (key, value) =>
                key.startsWith("prefill/")
                  ? Deferred.succeed(paused, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(blobs.put(key, value)),
                    )
                  : blobs.put(key, value),
            }),
          ),
          Layer.succeed(
            Db.Db,
            Db.Db.of({ ...db, knowledge: { ...db.knowledge, heartbeatPrefill: () => Effect.never } }),
          ),
        );
        const stalling = yield* run(ids.map(ref)).pipe(fresh(stalled), Effect.forkChild);
        yield* Deferred.await(paused);
        yield* query("update prefill_owner set heartbeat_at = now() - interval '2 minutes'");
        const other = yield* Effect.forkChild(run([]));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(stalling);
        expect((yield* Fiber.join(other)).manifests.dropped).toBe(0);
        yield* run(ids.map(ref));
        expect((yield* sweepAndConsume).filter((n) => ids.includes(n))).toEqual([]);
        expect(askedFor(f.asked, ids)).toEqual([]);
        expect(f.batches.paid.length - paidBefore).toBe(2);
        expect(
          yield* query("select count(*)::int as receipts from receipts where repo_id = any($1::bigint[])", [ids]),
        ).toEqual([{ receipts: 2 }]);
      }),
    );

    it.effect("moves every open manifest's lease before any waits, and waits on them all at once", () =>
      Effect.gen(function* () {
        const ids = range(9701, 6);
        f.seed(ids);
        f.batches.control.collecting = () =>
          Effect.fail(new AiRequestFailed({ operation: "generate", model: "fake/summary", detail: "status 401" }));
        expect(tally(yield* runWith(ids.map(ref), { chunk: 2 }))).toEqual({ waiting: 6 });
        const opened = (yield* query(
          "select id, provider_batch_id as batch from extraction_batches where repo_ids && $1::bigint[] order by created_at, id",
          [ids],
        )) as Array<{ id: string; batch: string }>;
        const slow = opened.slice(0, 2);
        f.batches.control.collecting = (batchId) =>
          slow.some((manifest) => manifest.batch === batchId) ? Effect.never : undefined;
        const resuming = yield* Effect.forkChild(runWith([], { chunk: 2, concurrency: 1 }));
        // The clock moves only once the resume is under way: the third manifest, whose batch answers, is captured.
        const fast = opened[2]?.id;
        yield* query("select state from extraction_batches where id = $1", [fast]).pipe(
          Effect.repeat({ until: (rows) => (rows[0] as { state: string }).state === "captured", times: 500 }),
        );
        const leaseOf = query(
          "select min(extract(epoch from lease_until) * 1000)::float8 as at from extraction_batches where id = any($1::uuid[])",
          [slow.map((manifest) => manifest.id)],
        ).pipe(Effect.map((rows) => (rows[0] as { at: number }).at));
        for (let hour = 1; hour <= 30; hour++) {
          yield* TestClock.adjust("1 hour");
          if (hour < 25) {
            const renewedBy = (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.hours(25));
            yield* leaseOf.pipe(Effect.repeat({ until: (at) => at > renewedBy, times: 500 }));
          }
          expect((yield* sweepAndConsume).filter((n) => ids.includes(n))).toEqual([]);
        }
        f.batches.control.collecting = undefined;
        const report = yield* Fiber.join(resuming);
        expect(tally(report)).toEqual({ saved: 2, waiting: 4 });
        expect(askedFor(f.asked, ids)).toEqual([]);
        expect(tally(yield* run([]))).toEqual({ saved: 4 });
      }),
    );

    it.effect("leaves a repo its open fallback owes to that fallback, even when their leases match", () =>
      Effect.gen(function* () {
        const ids = range(9801, 3);
        f.seed(ids);
        f.broken.once.add(9802);
        yield* killedAtCapture(ids.map(ref), 2);
        const submittedBefore = f.batches.submissions.length;
        yield* query(
          "update extraction_batches set lease_until = '2030-01-01T00:00:00Z' where repo_ids && $1::bigint[]",
          [ids],
        );
        yield* query("update repos set enrich_retry_at = '2030-01-01T00:00:00Z' where id = 9802");
        const resumed = yield* run(ids.map(ref));
        expect(tally(resumed)).toEqual({ saved: 1, done: 2 });
        expect(
          yield* query(
            "select retry_of is not null as fallback, state from extraction_batches where repo_ids && $1::bigint[] order by retry_of nulls first",
            [ids],
          ),
        ).toEqual([
          { fallback: false, state: "captured" },
          { fallback: true, state: "captured" },
        ]);
        expect(f.batches.submissions.length - submittedBefore).toBe(0);
      }),
    );

    it.effect("closes a stuck manifest once every repo it owed has moved on", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        const ids = range(9851, 2);
        f.seed(ids);
        yield* killedAtCapture(ids.map(ref), 1);
        yield* query("update repos set enrich_retry_at = null where id = any($1::bigint[])", [ids]);
        const lost = Layer.succeed(
          BlobStore.BlobStore,
          BlobStore.BlobStore.of({
            get: (key) => (key.startsWith("prefill/") ? Effect.succeedNone : blobs.get(key)),
            put: blobs.put,
          }),
        );
        const report = yield* runWith([], {}).pipe(fresh(lost));
        expect(report.manifests).toMatchObject({ stuck: [], closed: 1 });
        expect(yield* manifestOf(9851)).toMatchObject({ state: "captured" });
      }),
    );

    it.effect("deletes a manifest never sent that owes nothing, instead of failing to close it", () =>
      Effect.gen(function* () {
        const batches = yield* Batches.Batches;
        const ids = range(9901, 2);
        f.seed(ids);
        const reached = yield* Deferred.make<void>();
        const neverSends = Layer.succeed(
          Batches.Batches,
          Batches.Batches.of({
            ...batches,
            submit: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        );
        const stopped = yield* run(ids.map(ref)).pipe(fresh(neverSends), Effect.forkChild);
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(stopped);
        yield* query("update repos set enrich_retry_at = null where id = any($1::bigint[])", [ids]);
        const report = yield* runWith([], {});
        expect(report.manifests).toMatchObject({ dropped: 1, stuck: [] });
        expect(
          yield* query("select count(*)::int as manifests from extraction_batches where repo_ids && $1::bigint[]", [
            ids,
          ]),
        ).toEqual([{ manifests: 0 }]);
      }),
    );
  });
}
