import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { at, model, repoId } from "./fixtures.ts";

// PGlite has one connection, so this runs only where two transactions can interleave. Its own database keeps the
// repos table tiny, so Postgres scans it in heap order.

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
  "node-postgres lease concurrency",
  (test) => {
    // Every multi-row writer of repos locks its rows in ID order, so none of them waits on another in a cycle. Rows
    // written highest ID first sit in the heap in that order, so a lease that locked rows as it scanned them would
    // wait on the highest first, holding nothing.
    test.effect("a lease locks its rows in ID order, whatever order the heap holds them in", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const ids = [3, 2, 1].map((n) => repoId(76_000 + n));
        for (const id of ids) {
          yield* database.query(
            "insert into repos (id, owner, name) values ($1::bigint, 'probe', 'lease-' || $1::text)",
            [id],
          );
        }
        yield* database.query("analyze repos");
        const [highest, , lowest] = ids;
        if (highest === undefined || lowest === undefined) return yield* Effect.die("no repos");

        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holding = yield* Effect.forkChild(
          db.knowledge.project([highest], () =>
            Deferred.succeed(held, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ write: [], carry: undefined }),
            ),
          ),
        );
        yield* Deferred.await(held);
        const leasing = yield* Effect.forkChild(
          db.repos.lease({ ids, now: at("2026-05-01T00:00:00Z"), until: at("2026-05-01T00:15:00Z") }),
        );
        expect(yield* lockWait).toEqual(["transactionid"]);
        const free = yield* database.query(
          "select count(*)::int as free from (select id from repos where id = $1 for no key update skip locked) t",
          [lowest],
        );
        expect(free).toEqual([{ free: 0 }]);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holding);
        expect([...(yield* Fiber.join(leasing))].sort()).toEqual([...ids].sort());
      }),
    );
  },
);
