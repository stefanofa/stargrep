import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { facts, model, readme, repoId } from "./fixtures.ts";
import { allComplete, answer, atom, facetsOf, hash, key, receiptId, seedRepo } from "./knowledge-fixtures.ts";

// PGlite has one connection, so these run only where two transactions can interleave.

// Waits, inside Postgres, up to three seconds for a session of this database to wait on a lock, and returns what the
// waiting sessions wait on. A blocked session shows up within milliseconds, so an empty list means nothing blocked.
const lockWait = Effect.gen(function* () {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(`
    do $$ begin
      for attempt in 1 .. 300 loop
        exit when exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock');
        perform pg_sleep(0.01);
      end loop;
    end $$`);
  const waiting = yield* database.query(
    "select wait_event as event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return waiting.map((row) => (row as { event: string }).event);
});

it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "node-postgres knowledge concurrency",
  (test) => {
    // opus 4, the concurrent case: a projection reads the label index, misses a key, and is still committing when
    // another group mints that key. The mint waits for the projection's shared lock, then marks the row stale.
    test.effect("a mint waits for a projection that missed its key, then marks that repo stale", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const protocol = key("acme widget protocol");
        const consumer = yield* seedRepo({ id: 75_001, topics: ["acme widget protocol"] });
        const producer = yield* seedRepo({ id: 75_002 });
        yield* db.knowledge.capture([answer(producer, receiptId(75_002))]);
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const projecting = yield* Effect.forkChild(
          db.knowledge.project([consumer], (locked) =>
            Effect.gen(function* () {
              const labels = yield* db.knowledge.labels([protocol]);
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
              return locked.map((repo) => ({
                repoId: repo.id,
                receiptId: repo.receiptId,
                atoms: labels.map((label) => atom("tagged", { dim: "subject", id: label.subjectId })),
                unresolvedKeys: labels.length === 0 ? [protocol] : [],
                verdicts: [],
              }));
            }),
          ),
        );
        yield* Deferred.await(read);
        const minting = yield* Effect.forkChild(
          db.knowledge.mint([{ key: protocol, label: "acme widget protocol", receiptId: receiptId(75_002) }]),
        );
        expect(yield* lockWait).toEqual(["advisory"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(projecting)).toEqual({ projected: 1, skipped: 0 });
        expect((yield* Fiber.join(minting)).invalidated).toBe(1);
        expect(yield* facetsOf(consumer)).toMatchObject({ stale: true, tagged: [], unresolved: [protocol] });
      }),
    );

    test.effect("a facts update that lands mid-projection waits, then marks the row stale again", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const id = yield* seedRepo({ id: 75_101, language: "Go" });
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const projecting = yield* Effect.forkChild(
          db.knowledge.project([id], (repos) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
              return repos.map((repo) => ({
                repoId: repo.id,
                receiptId: repo.receiptId,
                atoms: [atom("written_in", { dim: "language", id: "go" })],
                unresolvedKeys: [],
                verdicts: [],
              }));
            }),
          ),
        );
        yield* Deferred.await(locked);
        const saving = yield* Effect.forkChild(db.repos.saveFacts({ ...facts(id), language: "Rust" }));
        expect(yield* lockWait).toEqual(["transactionid"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(projecting)).toEqual({ projected: 1, skipped: 0 });
        yield* Fiber.join(saving);
        const database = yield* TestDatabase.TestDatabase;
        expect(
          yield* database.query(
            "select r.language, r.written_in::text[] as atoms, f.stale from repos r join repo_facets f on f.repo_id = r.id where r.id = $1",
            [id],
          ),
        ).toEqual([{ language: "Rust", atoms: ["go"], stale: true }]);
      }),
    );

    test.effect("a legacy page holds its repos from read to write, so a summary saved meanwhile waits for it", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const id = repoId(75_301);
        yield* database.query(
          `insert into repos (id, owner, name, readme_oid, summary_readme_oid, summary, keywords, kind)
           values ($1, 'probe', 'legacy', $2, $2, 'Old summary', '["old"]', 'cli')`,
          [id, readme("1")],
        );
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const page = yield* Effect.forkChild(
          db.knowledge.keepLegacy({ after: id - 1, limit: 1 }, (repos) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
              return repos.map((repo) => ({
                repoId: repo.id,
                inputHash: hash("c"),
                recipe: repo.summaryRecipe,
                summary: repo.summary,
                keywords: repo.keywords,
                claims: [],
                lanes: allComplete,
                dropped: [],
              }));
            }),
          ),
        );
        yield* Deferred.await(read);
        const saving = yield* Effect.forkChild(
          db.repos.saveSummary({ id, readmeOid: readme("1"), summary: "New summary", keywords: ["new"], kind: "app" }),
        );
        expect(yield* lockWait).toEqual(["transactionid"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(page)).toMatchObject({ read: 1, inserted: 1, pointed: 1 });
        yield* Fiber.join(saving);
        expect(
          yield* database.query(
            "select r.summary, r.kind, c.summary as receipt from repos r join receipts c on c.id = r.receipt_id where r.id = $1",
            [id],
          ),
        ).toEqual([{ summary: "New summary", kind: "app", receipt: "Old summary" }]);
      }),
    );

    test.effect("two projections of one repo at once queue on its row and both finish", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const id = yield* seedRepo({ id: 75_201 });
        const projection = (kind: "cli" | "app", started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
          db.knowledge.project([id], (repos) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return repos.map((repo) => ({
                repoId: repo.id,
                receiptId: repo.receiptId,
                atoms: [atom("is", { dim: "kind", id: kind })],
                unresolvedKeys: [],
                verdicts: [],
              }));
            }),
          );
        const [firstStarted, firstRelease, secondStarted, secondRelease] = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ];
        yield* Deferred.succeed(secondRelease, undefined);
        const first = yield* Effect.forkChild(projection("cli", firstStarted, firstRelease));
        yield* Deferred.await(firstStarted);
        const second = yield* Effect.forkChild(projection("app", secondStarted, secondRelease));
        expect(yield* lockWait).toEqual(["transactionid"]);
        expect(yield* Deferred.isDone(secondStarted)).toBe(false);
        yield* Deferred.succeed(firstRelease, undefined);
        expect(yield* Fiber.join(first)).toEqual({ projected: 1, skipped: 0 });
        expect(yield* Fiber.join(second)).toEqual({ projected: 1, skipped: 0 });
        const database = yield* TestDatabase.TestDatabase;
        expect(yield* database.query("select kinds::text[] as kinds from repos where id = $1", [id])).toEqual([
          { kinds: ["app"] },
        ]);
      }),
    );
  },
);
