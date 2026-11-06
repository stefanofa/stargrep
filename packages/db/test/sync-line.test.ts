import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { at, model } from "./fixtures.ts";

const unit = Duration.millis(1_800);
const units = (count: number) => Duration.times(unit, count);
const tolerance = units(200);
const maxWait = Duration.hours(2);
const start = at("2026-11-06T09:00:00Z");
const later = (count: number) => DateTime.addDuration(start, units(count));

const reserve = (time: DateTime.Utc, cost: number, force = false) =>
  Db.Db.use((db) => db.syncLine.reserve({ at: time, cost: units(cost), tolerance, maxWait, force }));

const busyFor = (time: DateTime.Utc) => Db.Db.use((db) => db.syncLine.wait(time, Duration.zero));

const clear = TestDatabase.TestDatabase.use((database) => database.query("delete from sync_line"));

const cases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("starts a reservation on an empty line now and moves the line by its cost", () =>
    Effect.gen(function* () {
      yield* clear;
      expect(yield* Db.Db.use((db) => db.syncLine.wait(start, tolerance))).toEqual(Duration.zero);
      expect(yield* reserve(start, 27)).toEqual(Option.some(start));
      expect(yield* busyFor(start)).toEqual(units(27));
    }),
  );

  test.effect("starts every reservation inside the burst now, and the next at the line less the burst", () =>
    Effect.gen(function* () {
      yield* clear;
      for (let index = 0; index < 8; index++) expect(yield* reserve(start, 27)).toEqual(Option.some(start));
      expect(yield* reserve(start, 27)).toEqual(Option.some(later(8 * 27 - 200)));
      expect(yield* Db.Db.use((db) => db.syncLine.wait(start, tolerance))).toEqual(units(9 * 27 - 200));
    }),
  );

  test.effect("refuses a reservation that would wait past the limit and leaves the line as it was", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* reserve(start, 4_000);
      expect(yield* reserve(start, 3)).toEqual(Option.some(later(3_800)));
      yield* reserve(start, 300);
      expect(yield* busyFor(start)).toEqual(units(4_303));
      expect(yield* reserve(start, 3)).toEqual(Option.none());
      expect(yield* busyFor(start)).toEqual(units(4_303));
    }),
  );

  test.effect("takes a forced reservation past the limit and still moves the line by its cost", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* reserve(start, 4_400);
      expect(yield* reserve(start, 1, true)).toEqual(Option.some(later(4_200)));
      expect(yield* busyFor(start)).toEqual(units(4_401));
    }),
  );

  test.effect("is clear once the clock passes the line, and starts the next reservation at once", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* reserve(start, 4_000);
      const after = later(4_001);
      expect(yield* Db.Db.use((db) => db.syncLine.wait(after, tolerance))).toEqual(Duration.zero);
      expect(yield* reserve(after, 27)).toEqual(Option.some(after));
      expect(yield* busyFor(after)).toEqual(units(27));
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite sync line", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres sync line",
  (test) => {
    cases(test);

    test.effect("gives ten reservations made at once ten different starts", () =>
      Effect.gen(function* () {
        yield* clear;
        const starts = yield* Effect.all(
          Array.from({ length: 10 }, () => reserve(start, 250)),
          { concurrency: "unbounded" },
        );
        const millis = starts
          .map((reserved) => DateTime.toEpochMillis(Option.getOrThrow(reserved)))
          .sort((a, b) => a - b);
        expect(millis).toEqual(
          Array.from({ length: 10 }, (_, index) =>
            DateTime.toEpochMillis(index === 0 ? start : later(250 * index - 200)),
          ),
        );
        expect(yield* busyFor(start)).toEqual(units(2_500));
      }),
    );
  },
);
