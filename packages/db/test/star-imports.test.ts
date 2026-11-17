import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { model } from "./fixtures.ts";

const first = "00000000-0000-4000-8000-0000000071aa";
const second = "00000000-0000-4000-8000-0000000071bb";
const stale = Duration.minutes(1);

const age = (seconds: number) =>
  Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) =>
    database.query(`update star_import_owner set heartbeat_at = now() - interval '${seconds} seconds'`),
  );

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("lets one driver hold the import until its heartbeat, on the database's clock, goes stale", () =>
    Effect.gen(function* () {
      const { starImports } = yield* Db.Db;
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(false);
      yield* age(50);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(false);
      expect(yield* starImports.heartbeat(first)).toBe(true);
      yield* age(90);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(true);
      expect(yield* starImports.heartbeat(first)).toBe(false);
      yield* starImports.release(first);
      expect(yield* starImports.heartbeat(second)).toBe(true);
      yield* starImports.release(second);
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      yield* starImports.release(first);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite star import owner", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres star import owner",
  cases,
);
