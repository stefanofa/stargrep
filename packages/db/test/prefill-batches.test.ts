import { expect } from "bun:test";
import { BatchId, InputHash } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
  recipe: 2,
  requestKey: `key-${id}`,
  requestObject: `prefill/requests/key-${id}.json`,
  providerBatchId: null,
  repoIds: repos.map((n) => repoId(n)),
  inputHashes: repos.map(() => hash),
  state: "prepared",
  leaseUntil: lease,
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
        yield* db.repos.saveFactsAndLease({ repos: [6001, 6002, 6003].map(prefillFacts), now, until: lease });
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

        yield* db.repos.saveFactsAndLease({ repos: [prefillFacts(6004)], now, until: lease });
        const unsent = manifest("00000000-0000-4000-8000-000000006004", [6004]);
        yield* db.knowledge.prepareBatch(unsent);
        yield* db.knowledge.dropBatch(unsent);
        expect(yield* retryAt(6004)).toBeNull();
        expect(yield* query("select count(*)::int as n from extraction_batches where id = $1", [unsent.id])).toEqual([
          { n: 0 },
        ]);
      }),
    );
  });
}
