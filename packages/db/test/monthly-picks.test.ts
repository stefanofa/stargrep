import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import { UserId } from "../src/auth-schema.ts";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { model } from "./fixtures.ts";

const signUp = (name: string) =>
  Effect.gen(function* () {
    yield* (yield* TestDatabase.TestDatabase).query(`insert into "user" (id, name, email) values ($1, $2, $3)`, [
      name,
      name,
      `${name}@example.test`,
    ]);
    return UserId.make(name);
  });

const waitlist = Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) =>
  database.query("select user_id from monthly_picks order by user_id"),
);

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("a user is off until they opt in, and a repeated switch changes nothing", () =>
    Effect.gen(function* () {
      const { monthlyPicks } = yield* Db.Db;
      const ada = yield* signUp("ada");
      expect(yield* monthlyPicks.optedIn(ada)).toBe(false);

      expect([yield* monthlyPicks.set(ada, true), yield* monthlyPicks.set(ada, true)]).toEqual([true, false]);
      expect(yield* monthlyPicks.optedIn(ada)).toBe(true);
      expect(yield* waitlist).toEqual([{ user_id: "ada" }]);

      expect([yield* monthlyPicks.set(ada, false), yield* monthlyPicks.set(ada, false)]).toEqual([true, false]);
      expect(yield* monthlyPicks.optedIn(ada)).toBe(false);
      expect(yield* waitlist).toEqual([]);
    }),
  );

  test.effect("deleting a user takes them off the waitlist", () =>
    Effect.gen(function* () {
      const { monthlyPicks } = yield* Db.Db;
      const grace = yield* signUp("grace");
      yield* monthlyPicks.set(grace, true);
      yield* (yield* TestDatabase.TestDatabase).query(`delete from "user" where id = $1`, [grace]);
      expect(yield* waitlist).toEqual([]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite monthly picks", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres monthly picks",
  cases,
);
