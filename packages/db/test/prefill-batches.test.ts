import { expect } from "bun:test";
import { summaryRecipe } from "@stargrep/ai/models";
import { BatchId, InputHash } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import pg from "pg";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { facts, model, readme, ref, repoId } from "./fixtures.ts";
import { summarize } from "./summaries.ts";

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel: model })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel: model })],
] as const;

const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z");
const lease = DateTime.makeUnsafe("2026-11-11T14:00:00Z");
const later = DateTime.makeUnsafe("2026-11-11T20:00:00Z");
const hash = InputHash.make("a".repeat(64));

const prefillFacts = (n: number) => ({ ...facts(repoId(n)), nodeId: ref(repoId(n)).nodeId, stars: 10, forks: 1 });

const manifest = (id: string, repos: ReadonlyArray<number>): Db.Manifest => ({
  id: BatchId.make(id),
  adapter: "gateway-batch",
  model: "test/model",
  recipe: summaryRecipe,
  requestKey: `key-${id}`,
  requestObject: `prefill/requests/key-${id}.json`,
  providerBatchId: null,
  repoIds: repos.map((n) => repoId(n)),
  inputHashes: repos.map(() => hash),
  state: "prepared",
  leaseUntil: lease,
  retryOf: null,
});

for (const [adapter, database] of adapters) {
  const query = (text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) => test.query(text, values));
  const retryAt = (n: number) =>
    Effect.map(
      query("select to_char(enrich_retry_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') as at from repos where id = $1", [
        n,
      ]),
      (rows) => (rows[0] as { at: string | null }).at,
    );

  it.layer(database, { timeout: 30_000 })(`prefill manifests on ${adapter}`, (test) => {
    test.effect("saves a chunk's facts and leases only the repos due and free, in one statement", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.upsertRefs([ref(repoId(5002)), ref(repoId(5003))]);
        yield* db.repos.saveFacts({ ...facts(repoId(5003)), readmeOid: readme("3") });
        yield* summarize({ id: repoId(5003), readmeOid: readme("3"), summary: "Done", keywords: [] });
        yield* db.repos.lease({ ids: [repoId(5002)], now, until: DateTime.makeUnsafe("2026-11-10T12:15:00Z") });

        const leases = yield* db.repos.saveFactsAndLease({
          askCurrent: false,
          repos: [prefillFacts(5003), prefillFacts(5001), { ...prefillFacts(5002), description: "Moved" }].map(
            (repo) => (repo.id === 5003 ? { ...repo, readmeOid: readme("3") } : repo),
          ),
          now,
          until: lease,
        });
        expect(leases.map(({ id, leased }) => [Number(id), leased]).sort()).toEqual([
          [5001, true],
          [5002, false],
          [5003, false],
        ]);
        expect(yield* retryAt(5001)).toBe("2026-11-11 14:00");
        expect(yield* retryAt(5002)).toBe("2026-11-10 12:15");
        expect(yield* retryAt(5003)).toBeNull();
        expect(
          yield* query("select description, stars from repos join repo_metrics on repo_id = id where id = 5002"),
        ).toEqual([{ description: "Moved", stars: 10 }]);
      }),
    );

    test.effect("extends, closes, and drops a manifest by the repos still holding its lease", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.saveFactsAndLease({
          repos: [6001, 6002, 6003].map(prefillFacts),
          now,
          until: lease,
          askCurrent: false,
        });
        const sent = manifest("00000000-0000-4000-8000-000000006001", [6001, 6002, 6003]);
        yield* db.knowledge.prepareBatch(sent);
        yield* db.knowledge.submittedBatch({ id: sent.id, providerBatchId: "batch_1" });
        // 6001 was captured, and 6002's lease ran out and another attempt took it.
        yield* query("update repos set enrich_retry_at = null where id = 6001");
        yield* query("update repos set enrich_retry_at = '2026-11-12T00:00:00Z' where id = 6002");

        const [open] = yield* db.knowledge.openBatches;
        expect(open).toMatchObject({ id: sent.id, state: "submitted", providerBatchId: "batch_1" });
        expect(open?.repoIds.map(Number)).toEqual([6001, 6002, 6003]);
        expect(open?.leaseUntil).toEqual(lease);
        expect((yield* db.knowledge.extendBatch({ manifest: sent, until: later })).map(Number)).toEqual([6003]);
        expect(yield* retryAt(6003)).toBe("2026-11-11 20:00");
        expect(yield* retryAt(6002)).toBe("2026-11-12 00:00");

        const extended = { ...sent, leaseUntil: later };
        expect(yield* db.knowledge.closeBatch(extended)).toBe(false);
        yield* query("update repos set enrich_retry_at = null where id = 6003");
        expect(yield* db.knowledge.closeBatch(extended)).toBe(true);
        expect(yield* db.knowledge.openBatches).toEqual([]);
      }),
    );

    test.effect("reopens a closed manifest that has the same request key, and refuses one an open manifest holds", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const first = manifest("00000000-0000-4000-8000-000000006101", [6101]);
        expect(yield* db.knowledge.prepareBatch(first)).toEqual(Option.some(first.id));
        const again = { ...manifest("00000000-0000-4000-8000-000000006102", [6101]), requestKey: first.requestKey };
        expect(yield* db.knowledge.prepareBatch(again)).toEqual(Option.none());
        yield* db.knowledge.submittedBatch({ id: first.id, providerBatchId: "batch_old" });
        expect(yield* db.knowledge.closeBatch(first)).toBe(true);
        expect(yield* db.knowledge.prepareBatch({ ...again, leaseUntil: later })).toEqual(Option.some(first.id));
        expect(
          yield* query(
            `select state, provider_batch_id as "providerBatchId",
               to_char(lease_until at time zone 'utc', 'YYYY-MM-DD HH24:MI') as lease
             from extraction_batches where request_key = $1`,
            [first.requestKey],
          ),
        ).toEqual([{ state: "prepared", providerBatchId: null, lease: "2026-11-11 20:00" }]);
      }),
    );

    test.effect("drops only a manifest that was never sent, and only for the driver that holds the prefill", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.saveFactsAndLease({
          repos: [6201, 6202].map(prefillFacts),
          now,
          until: lease,
          askCurrent: false,
        });
        const unsent = manifest("00000000-0000-4000-8000-000000006201", [6201]);
        const sent = manifest("00000000-0000-4000-8000-000000006202", [6202]);
        yield* db.knowledge.prepareBatch(unsent);
        yield* db.knowledge.prepareBatch(sent);
        yield* db.knowledge.submittedBatch({ id: sent.id, providerBatchId: "batch_paid" });
        const owner = "00000000-0000-4000-8000-0000000062aa";
        expect(yield* db.knowledge.dropBatch({ manifest: unsent, owner })).toBe(false);
        expect(yield* db.knowledge.claimPrefill({ owner, stale: Duration.minutes(1) })).toBe(true);
        expect(yield* db.knowledge.dropBatch({ manifest: sent, owner })).toBe(false);
        expect(yield* retryAt(6202)).toBe("2026-11-11 14:00");
        expect(yield* db.knowledge.dropBatch({ manifest: unsent, owner })).toBe(true);
        expect(yield* retryAt(6201)).toBeNull();
        expect(
          (yield* db.knowledge.openBatches).flatMap((open) =>
            [unsent.id, sent.id].includes(open.id) ? [open.id] : [],
          ),
        ).toEqual([sent.id]);
        yield* db.knowledge.releasePrefill(owner);
      }),
    );

    // The database's clock decides, so two drivers on machines whose clocks disagree still agree on who holds it.
    test.effect("lets one driver hold the prefill until its heartbeat, on the database's clock, goes stale", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const first = "00000000-0000-4000-8000-0000000063aa";
        const second = "00000000-0000-4000-8000-0000000063bb";
        const stale = Duration.minutes(1);
        const age = (seconds: number) =>
          query(`update prefill_owner set heartbeat_at = now() - interval '${seconds} seconds'`);
        expect(yield* db.knowledge.claimPrefill({ owner: first, stale })).toBe(true);
        expect(yield* db.knowledge.claimPrefill({ owner: second, stale })).toBe(false);
        yield* age(50);
        expect(yield* db.knowledge.claimPrefill({ owner: second, stale })).toBe(false);
        expect(yield* db.knowledge.heartbeatPrefill(first)).toBe(true);
        yield* age(90);
        expect(yield* db.knowledge.claimPrefill({ owner: second, stale })).toBe(true);
        expect(yield* db.knowledge.heartbeatPrefill(first)).toBe(false);
        yield* db.knowledge.releasePrefill(first);
        expect(yield* db.knowledge.heartbeatPrefill(second)).toBe(true);
        yield* db.knowledge.releasePrefill(second);
      }),
    );

    test.effect("leaves the repos an open fallback lists to that fallback, even when their leases match", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.saveFactsAndLease({
          repos: [6501, 6502].map(prefillFacts),
          now,
          until: lease,
          askCurrent: false,
        });
        const parent = manifest("00000000-0000-4000-8000-000000006501", [6501, 6502]);
        const child = {
          ...manifest("00000000-0000-4000-8000-000000006502", [6502]),
          retryOf: parent.id,
        };
        yield* db.knowledge.prepareBatch(parent);
        yield* db.knowledge.submittedBatch({ id: parent.id, providerBatchId: "batch_parent" });
        yield* db.knowledge.prepareBatch(child);
        yield* query("update repos set enrich_retry_at = null where id = 6501");
        expect(yield* db.knowledge.extendBatch({ manifest: parent, until: later })).toEqual([]);
        expect(yield* retryAt(6502)).toBe("2026-11-11 14:00");
        expect(yield* db.knowledge.closeBatch(parent)).toBe(true);
        expect((yield* db.knowledge.extendBatch({ manifest: child, until: later })).map(Number)).toEqual([6502]);
      }),
    );

    test.effect("records a manifest's final failures once each", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const failing = manifest("00000000-0000-4000-8000-000000006601", [6601, 6602]);
        yield* db.knowledge.prepareBatch(failing);
        yield* db.knowledge.recordFailed({ id: failing.id, repoIds: [repoId(6601)] });
        yield* db.knowledge.recordFailed({ id: failing.id, repoIds: [repoId(6601), repoId(6602)] });
        expect(
          yield* query(
            "select array(select unnest(failed_repo_ids)::int order by 1) as failed from extraction_batches where id = $1",
            [failing.id],
          ),
        ).toEqual([{ failed: [6601, 6602] }]);
      }),
    );

    test.effect("asks a repo whose summary is current only when askCurrent is set, and only once per recipe", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.upsertRefs([ref(repoId(6701))]);
        yield* db.repos.saveFacts({ ...facts(repoId(6701)), readmeOid: readme("7") });
        yield* summarize({ id: repoId(6701), readmeOid: readme("7"), summary: "Done", keywords: [] });
        const current = { ...prefillFacts(6701), readmeOid: readme("7") };
        expect((yield* db.repos.summarized([repoId(6701)])).map(Number)).toEqual([6701]);
        expect((yield* db.repos.summarized([repoId(6701)], true)).map(Number)).toEqual([]);
        const quiet = yield* db.repos.saveFactsAndLease({ repos: [current], now, until: lease, askCurrent: false });
        expect(quiet.map(({ leased }) => leased)).toEqual([false]);
        const asked = yield* db.repos.saveFactsAndLease({ repos: [current], now, until: lease, askCurrent: true });
        expect(asked.map(({ leased }) => leased)).toEqual([true]);
        yield* db.knowledge.prepareBatch(manifest("00000000-0000-4000-8000-000000006701", [6701]));
        expect((yield* db.repos.summarized([repoId(6701)], true)).map(Number)).toEqual([6701]);
      }),
    );

    test.effect("hands a lease over only from repos that still hold it", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* db.repos.saveFactsAndLease({
          repos: [6301, 6302].map(prefillFacts),
          now,
          until: lease,
          askCurrent: false,
        });
        yield* query("update repos set enrich_retry_at = null where id = 6302");
        const moved = yield* db.knowledge.moveLease({ ids: [repoId(6301), repoId(6302)], from: lease, to: later });
        expect(moved.map(Number)).toEqual([6301]);
        expect(yield* retryAt(6301)).toBe("2026-11-11 20:00");
        expect(yield* retryAt(6302)).toBeNull();
      }),
    );
  });
}

// PGlite has one connection, so only Postgres can show a prepare waiting on a mint.
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "prefill lock order on Postgres",
  (test) => {
    // A mint holds the exclusive knowledge lock and marks repo_facets rows stale in heap order. A prepare that saved
    // facts first would mark them in ID order and could deadlock with it, so it waits on the shared lock instead.
    test.effect("a chunk's facts wait for the knowledge lock a mint holds, before they touch a row", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const transactions = yield* Db.Transactions;
        const database = yield* TestDatabase.TestDatabase;
        const url = Option.getOrThrow(database.url);
        const minting = new pg.Client({ connectionString: url });
        yield* Effect.promise(() => minting.connect());
        yield* Effect.promise(() => minting.query("begin"));
        yield* Effect.promise(() =>
          minting.query("select pg_advisory_xact_lock(hashtextextended('stargrep:knowledge:public', 0))"),
        );
        const saving = yield* Effect.forkChild(
          transactions.withTransaction(
            db.repos.saveFactsAndLease({ repos: [prefillFacts(6401)], now, until: lease, askCurrent: false }),
          ),
        );
        yield* database.query(`
          do $$ begin
            for attempt in 1 .. 300 loop
              exit when exists (
                select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory');
              perform pg_sleep(0.01);
            end loop;
          end $$`);
        const waiting = yield* database.query(
          "select wait_event as event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        const touched = yield* database.query("select count(*)::int as n from repos where id = 6401");
        yield* Effect.promise(() => minting.query("commit"));
        yield* Effect.promise(() => minting.end());
        yield* Fiber.join(saving);
        expect(waiting).toEqual([{ event: "advisory" }]);
        expect(touched).toEqual([{ n: 0 }]);
      }),
    );
  },
);
