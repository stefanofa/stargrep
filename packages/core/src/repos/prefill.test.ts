import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";
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

const quiet = { resumed: 0, dropped: 0, created: 0, closed: 0, fallbacks: 0, stuck: [] };

for (const [adapter, database] of adapters) {
  const f = fixture();

  it.layer(f.layer(database), { timeout: 60_000 })(`prefill on ${adapter}`, (it) => {
    it.effect("saves a chunk through one batch, with its manifest, receipts, atoms, and embeddings", () =>
      Effect.gen(function* () {
        f.seed(range(1001, 3));
        const report = yield* run(range(1001, 3).map(ref));
        expect(tally(report)).toEqual({ saved: 3 });
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 1 });
        const [manifest] = yield* query(
          "select state, adapter, model, cardinality(repo_ids)::int as items, provider_batch_id is not null as named from extraction_batches",
        );
        expect(manifest).toEqual({
          state: "captured",
          adapter: "gateway-batch",
          model: "fake/summary",
          items: 3,
          named: true,
        });
        expect(
          yield* query(
            `select count(*)::int as receipts, count(*) filter (where c.batch_id is not null)::int as batched,
               count(*) filter (where r.embedding is not null and r.enrich_retry_at is null)::int as read,
               count(*) filter (where not f.stale)::int as projected
             from receipts c join repos r on r.receipt_id = c.id join repo_facets f on f.repo_id = r.id
             where r.id between 1001 and 1003`,
          ),
        ).toEqual([{ receipts: 3, batched: 3, read: 3, projected: 3 }]);
        expect(askedFor(f.asked, range(1001, 3))).toEqual([]);
      }),
    );

    it.effect("keeps a repo only when GitHub's ID for its name is the archive's", () =>
      Effect.gen(function* () {
        f.seed([1101]);
        f.remotes.set(1102, { description: "Another repo took this name", databaseId: 9_999_102 });
        const report = yield* run([ref(1101), ref(1102), ref(1103)]);
        expect(tally(report)).toEqual({ saved: 1, unresolved: 2 });
        expect(report.unresolved).toEqual([
          { id: RepoId.make(1102), reason: "other-repo" },
          { id: RepoId.make(1103), reason: "missing" },
        ]);
        expect(yield* query("select count(*)::int as stored from repos where id in (1102, 1103, 9999102)")).toEqual([
          { stored: 0 },
        ]);
      }),
    );

    it.effect("skips a repo that is private now, by name and through the node ID Stargrep already holds", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        for (const n of [1151, 1152]) {
          f.remotes.set(n, { description: "Gone private", readme: "# Private", isPrivate: true });
        }
        yield* db.repos.upsertRefs([
          {
            id: RepoId.make(1151),
            nodeId: RepoNodeId.make("R_1151"),
            owner: Login.make("owner"),
            name: RepoName.make("repo-1151"),
          },
        ]);
        const report = yield* run([ref(1151), ref(1152)]);
        expect(tally(report)).toEqual({ unresolved: 2 });
        expect(report.unresolved.map(({ id, reason }) => [Number(id), reason])).toEqual([
          [1151, "forbidden"],
          [1152, "forbidden"],
        ]);
        expect(
          yield* query(
            "select count(*)::int as summarized from repos where id in (1151, 1152) and summary is not null",
          ),
        ).toEqual([{ summarized: 0 }]);
        expect(
          yield* query("select count(*)::int as manifests from extraction_batches where repo_ids && '{1151,1152}'"),
        ).toEqual([{ manifests: 0 }]);
      }),
    );

    // Pilot 2 asks prod repos the sweep already summarized under the current recipe, so it can compare their batch
    // answers with recipe 1. The answer converges on the receipt the repo has, and the manifest records it was asked.
    it.effect("asks repos whose summary is current only with askCurrent, and each once per recipe", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const ids = range(1301, 2);
        f.seed(ids);
        yield* db.repos.upsertRefs(
          ids.map((n) => ({
            id: RepoId.make(n),
            nodeId: RepoNodeId.make(`R_${n}`),
            owner: Login.make("owner"),
            name: RepoName.make(`repo-${n}`),
          })),
        );
        yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
          enricher.enrichRepos(ids.map((n) => RepoId.make(n))),
        );
        const paidBefore = f.batches.paid.length;
        expect(tally(yield* run(ids.map(ref)))).toEqual({ done: 2 });
        expect(f.batches.paid.length - paidBefore).toBe(0);
        expect(tally(yield* runWith(ids.map(ref), { askCurrent: true }))).toEqual({ saved: 2 });
        expect(f.batches.paid.length - paidBefore).toBe(2);
        expect(tally(yield* runWith(ids.map(ref), { askCurrent: true }))).toEqual({ done: 2 });
        expect(f.batches.paid.length - paidBefore).toBe(2);
        expect(
          yield* query("select count(*)::int as receipts from receipts where repo_id = any($1::bigint[])", [ids]),
        ).toEqual([{ receipts: 2 }]);
      }),
    );

    it.effect("leaves a repo another attempt holds to that attempt", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.seed([1201, 1202]);
        yield* run([ref(1201)]);
        yield* db.repos.upsertRefs([
          {
            id: RepoId.make(1202),
            nodeId: RepoNodeId.make("R_1202"),
            owner: Login.make("owner"),
            name: RepoName.make("repo-1202"),
          },
        ]);
        const now = yield* DateTime.now;
        yield* db.repos.lease({
          ids: [RepoId.make(1202)],
          now,
          until: DateTime.addDuration(now, EnrichRetry.attemptLease),
        });
        const report = yield* run([ref(1202)]);
        expect(tally(report)).toEqual({ held: 1 });
        expect(yield* query("select count(*)::int as receipts from receipts where repo_id = 1202")).toEqual([
          { receipts: 0 },
        ]);
      }),
    );

    it.effect(
      "a run killed mid-batch resumes with no repaid item, no duplicate receipt, and no paid call from the sweep or the consumer a day later",
      () =>
        Effect.gen(function* () {
          const ids = range(2001, 150);
          f.seed(ids);
          const paidBefore = f.batches.paid.length;
          const submittedBefore = f.batches.submissions.length;
          const askedBefore = f.asked.length;
          yield* killedAtCapture(ids.map(ref), 2);

          const [held] = yield* query(
            `select count(*) filter (where r.receipt_id is not null)::int as saved,
               count(*) filter (where r.enrich_retry_at = b.lease_until)::int as leased
             from repos r, extraction_batches b where r.id = any(b.repo_ids) and b.state = 'submitted'`,
          );
          expect(held).toEqual({ saved: 64, leased: 86 });

          // A day and an hour later, past the Gateway's batch window, the lease still holds every owed repo. The
          // sweep and a consumer that gets every manifest repo, such as from a user's star sync, pay for none.
          yield* TestClock.adjust("25 hours");
          expect((yield* sweepAndConsume).filter((n) => ids.includes(n))).toEqual([]);
          const consumed = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
            enricher.enrichRepos(ids.map((n) => RepoId.make(n))),
          );
          expect(new Set(consumed.map((outcome) => outcome._tag))).toEqual(new Set(["Unchanged", "Backoff"]));
          expect(askedFor(f.asked.slice(askedBefore), ids)).toEqual([]);

          const resumed = yield* run(ids.map(ref));
          expect(resumed.manifests).toEqual({ ...quiet, resumed: 1, closed: 1 });
          expect(tally(resumed)).toEqual({ saved: 86, done: 64 });
          expect(resumed.repaid).toBe(0);
          expect(f.batches.submissions.slice(submittedBefore).map((submission) => submission.replayed)).toEqual([
            false,
          ]);
          expect(f.batches.paid.length - paidBefore).toBe(150);
          expect(askedFor(f.asked.slice(askedBefore), ids)).toEqual([]);
          expect(
            yield* query(
              `select count(*)::int as receipts, count(distinct repo_id)::int as repos,
                 count(*) filter (where r.receipt_id = c.id)::int as current
               from receipts c join repos r on r.id = c.repo_id where c.repo_id between 2001 and 2150`,
            ),
          ).toEqual([{ receipts: 150, repos: 150, current: 150 }]);
          expect(yield* query("select state from extraction_batches where $1 = any(repo_ids)", [2001])).toEqual([
            { state: "captured" },
          ]);

          // Rerunning the finished run sends nothing, reads nothing from GitHub, and writes nothing.
          const requests = f.github.sent.length;
          const rerun = yield* run(ids.map(ref));
          expect(tally(rerun)).toEqual({ done: 150 });
          expect(rerun.manifests).toEqual(quiet);
          expect(f.github.sent.length).toBe(requests);
          expect(f.batches.submissions.length - submittedBefore).toBe(1);
        }),
    );

    it.effect("asks items the batch answered badly in one fallback batch, and counts a repo that never decodes", () =>
      Effect.gen(function* () {
        f.seed([5001, 5002, 5003]);
        f.broken.always.add(5001);
        f.broken.once.add(5002);
        const paidBefore = f.batches.paid.length;
        const report = yield* run([ref(5001), ref(5002), ref(5003)]);
        f.broken.always.delete(5001);
        expect(tally(report)).toEqual({ saved: 2, failed: 1 });
        expect(report.retried.map(Number)).toEqual([5001, 5002]);
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 2, fallbacks: 1 });
        expect(f.batches.paid.length - paidBefore).toBe(5);
        expect(askedFor(f.asked, [5001, 5002, 5003])).toEqual([]);
        expect(
          yield* query(
            "select id::int, enrich_failures as failures, enrich_retry_at is not null as waiting, receipt_id is not null as saved from repos where id between 5001 and 5003 order by id",
          ),
        ).toEqual([
          { id: 5001, failures: 1, waiting: true, saved: false },
          { id: 5002, failures: 0, waiting: false, saved: true },
          { id: 5003, failures: 0, waiting: false, saved: true },
        ]);
        expect(
          yield* query(
            `select state, cardinality(repo_ids)::int as items, retry_of is not null as fallback
             from extraction_batches where 5001 = any(repo_ids) order by retry_of nulls first`,
          ),
        ).toEqual([
          { state: "captured", items: 3, fallback: false },
          { state: "captured", items: 2, fallback: true },
        ]);
      }),
    );

    it.effect("answers stale when facts move while the batch is open, and leaves the repo pending", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.seed([3001, 3002]);
        const moved = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              capture: (answers) =>
                Effect.gen(function* () {
                  const [row] = yield* db.repos.getMany([RepoId.make(3001)]);
                  if (row !== undefined) yield* db.repos.saveFacts({ ...row, description: "Moved on" });
                  return yield* db.knowledge.capture(answers);
                }),
            },
          }),
        );
        const report = yield* run([ref(3001), ref(3002)]).pipe(
          Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(moved))),
        );
        expect(tally(report)).toEqual({ saved: 1, stale: 1 });
        expect(
          yield* query(
            "select id::int, enrich_retry_at is null as free, receipt_id is null as unsaved from repos where id in (3001, 3002) order by id",
          ),
        ).toEqual([
          { id: 3001, free: true, unsaved: true },
          { id: 3002, free: true, unsaved: false },
        ]);
      }),
    );

    it.effect("leaves no manifest and no lease when a request cannot be stored, and prefills its repos again", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        f.seed([4001, 4002]);
        const submitted = f.batches.submissions.length;
        const lost = Layer.succeed(
          BlobStore.BlobStore,
          BlobStore.BlobStore.of({
            get: blobs.get,
            put: (key, value) =>
              key.startsWith("prefill/")
                ? Effect.fail(new BlobStore.BlobStoreFailed({ operation: "put", key, cause: null }))
                : blobs.put(key, value),
          }),
        );
        const failed = yield* Effect.flip(
          run([ref(4001), ref(4002)]).pipe(Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(lost)))),
        );
        expect(failed._tag).toBe("BlobStoreFailed");
        expect(
          yield* query("select count(*)::int as manifests from extraction_batches where repo_ids && '{4001,4002}'"),
        ).toEqual([{ manifests: 0 }]);
        expect(
          yield* query(
            "select count(*)::int as leased from repos where id in (4001, 4002) and enrich_retry_at is not null",
          ),
        ).toEqual([{ leased: 0 }]);
        const report = yield* run([ref(4001), ref(4002)]);
        expect(report.manifests).toEqual({ ...quiet, created: 1, closed: 1 });
        expect(tally(report)).toEqual({ saved: 2 });
        expect(f.batches.submissions.length - submitted).toBe(1);
      }),
    );
  });
}
