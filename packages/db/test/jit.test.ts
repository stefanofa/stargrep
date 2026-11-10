import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as TestDatabase from "./database.ts";
import { model } from "./fixtures.ts";

// A session reads database parameters when it opens, so the migration's setting is what every later session starts with.
const cases = (test: { readonly effect: it.Tester<TestDatabase.TestDatabase> }) =>
  test.effect("a migrated database starts every new session with JIT off", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      expect(
        yield* database.query(
          `select setconfig from pg_db_role_setting
           where setrole = 0 and setdatabase = (select oid from pg_database where datname = current_database())`,
        ),
      ).toEqual([{ setconfig: ["jit=off"] }]);
    }),
  );

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 60_000 })("PGlite settings", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 60_000 })(
  "node-postgres settings",
  cases,
);
