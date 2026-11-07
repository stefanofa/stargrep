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
const all = Db.LineKey.make("all");
const later = (count: number) => DateTime.addDuration(start, units(count));

const take = (time: DateTime.Utc, cost: number, force = false) =>
  Db.Db.use((db) => db.rateLines.reserve({ line: all, at: time, cost: units(cost), tolerance, maxWait, force }));

const reserve = (time: DateTime.Utc, cost: number, force = false) =>
  Effect.map(
    take(time, cost, force),
    Option.map((reserved) => reserved.startsAt),
  );

const release = (reserved: Option.Option<Db.Reserved>, time: DateTime.Utc) =>
  Db.Db.use((db) => db.rateLines.release(Option.getOrThrow(reserved), time));

const busyFor = (time: DateTime.Utc, line = all) => Db.Db.use((db) => db.rateLines.wait(line, time, Duration.zero));

// A caller's line: 4 new logins at once, then one every 15 minutes, and never a wait.
const quarter = Duration.minutes(15);
const caller = (name: string) => Db.LineKey.make(`caller/${name}`);
const reserveNew = (name: string, time: DateTime.Utc) =>
  Db.Db.use((db) =>
    db.rateLines.reserve({
      line: caller(name),
      at: time,
      cost: quarter,
      tolerance: Duration.times(quarter, 3),
      maxWait: Duration.zero,
      force: false,
    }),
  ).pipe(Effect.map(Option.map((reserved) => reserved.startsAt)));

const adjust = (time: DateTime.Utc, count: number) => Db.Db.use((db) => db.rateLines.adjust(all, time, units(count)));

const query = (text: string) => TestDatabase.TestDatabase.use((database) => database.query(text));

const clear = query("delete from rate_lines");

const lines = Effect.map(query("select key from rate_lines order by key"), (rows) =>
  (rows as ReadonlyArray<{ readonly key: string }>).map((row) => row.key),
);

const cases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("starts a reservation on an empty line now and moves the line by its cost", () =>
    Effect.gen(function* () {
      yield* clear;
      expect(yield* Db.Db.use((db) => db.rateLines.wait(all, start, tolerance))).toEqual(Duration.zero);
      expect(yield* reserve(start, 27)).toEqual(Option.some(start));
      expect(yield* busyFor(start)).toEqual(units(27));
    }),
  );

  test.effect("starts every reservation inside the burst now, and the next at the line less the burst", () =>
    Effect.gen(function* () {
      yield* clear;
      for (let index = 0; index < 8; index++) expect(yield* reserve(start, 27)).toEqual(Option.some(start));
      expect(yield* reserve(start, 27)).toEqual(Option.some(later(8 * 27 - 200)));
      expect(yield* Db.Db.use((db) => db.rateLines.wait(all, start, tolerance))).toEqual(units(9 * 27 - 200));
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
      expect(yield* Db.Db.use((db) => db.rateLines.wait(all, after, tolerance))).toEqual(Duration.zero);
      expect(yield* reserve(after, 27)).toEqual(Option.some(after));
      expect(yield* busyFor(after)).toEqual(units(27));
    }),
  );

  test.effect(
    "starts a caller's first 4 new logins at once, refuses the fifth, and starts one more 15 minutes on",
    () =>
      Effect.gen(function* () {
        yield* clear;
        for (let index = 0; index < 4; index++)
          expect(yield* reserveNew("caller-a", start)).toEqual(Option.some(start));
        expect(yield* reserveNew("caller-a", start)).toEqual(Option.none());
        expect(yield* reserveNew("caller-b", start)).toEqual(Option.some(start));
        expect(yield* busyFor(start)).toEqual(Duration.zero);

        const fourteen = DateTime.addDuration(start, Duration.minutes(14));
        expect(yield* reserveNew("caller-a", fourteen)).toEqual(Option.none());
        const fifteen = DateTime.addDuration(start, quarter);
        expect(yield* reserveNew("caller-a", fifteen)).toEqual(Option.some(fifteen));
        expect(yield* reserveNew("caller-a", fifteen)).toEqual(Option.none());
      }),
  );

  test.effect("prunes the lines the clock has passed, and keeps the busy ones", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* reserveNew("caller-a", start);
      yield* reserveNew("caller-b", DateTime.addDuration(start, Duration.minutes(10)));
      yield* reserve(start, 27);
      const twenty = DateTime.addDuration(start, Duration.minutes(20));
      yield* Db.Db.use((db) => db.rateLines.prune(twenty));
      expect(yield* lines).toEqual(["caller/caller-b"]);
      expect(yield* reserveNew("caller-a", twenty)).toEqual(Option.some(twenty));
    }),
  );

  test.effect("bills a line by a positive adjustment, as a forced reservation would", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* adjust(start, 30);
      expect(yield* busyFor(start)).toEqual(units(30));
      yield* adjust(later(10), 5);
      expect(yield* busyFor(start)).toEqual(units(35));
      yield* adjust(later(100), 5);
      expect(yield* busyFor(later(100))).toEqual(units(5));
    }),
  );

  test.effect("releases a line by a negative adjustment, never earlier than now", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* reserve(start, 300);
      yield* adjust(start, -100);
      expect(yield* busyFor(start)).toEqual(units(200));
      expect(yield* reserve(start, 1)).toEqual(Option.some(start));
      yield* adjust(later(150), -500);
      expect(yield* busyFor(later(150))).toEqual(Duration.zero);
      yield* adjust(later(150), 2);
      expect(yield* busyFor(later(150))).toEqual(units(2));
    }),
  );

  test.effect("releases a reservation the line still owes in full, which moves later ones earlier", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      yield* take(start, 20);
      yield* release(first, start);
      expect(yield* busyFor(start)).toEqual(units(20));
    }),
  );

  test.effect("releases only the part of a reservation the line has not paid out", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      yield* take(start, 5);
      yield* release(first, later(4));
      expect(yield* busyFor(later(4))).toEqual(units(5));
    }),
  );

  test.effect("releases nothing for a reservation the line has paid out, so later work keeps its debt", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      yield* take(later(12), 5);
      yield* release(first, later(12));
      expect(yield* busyFor(later(12))).toEqual(units(5));
    }),
  );

  test.effect("releases what is left of a reservation after an earlier one was given back", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      const second = yield* take(start, 20);
      yield* release(first, start);
      yield* release(second, later(5));
      expect(yield* busyFor(later(5))).toEqual(Duration.zero);
      yield* release(second, later(6));
      expect(yield* busyFor(later(6))).toEqual(Duration.zero);
    }),
  );

  test.effect(
    "releases only what is left of a reservation an earlier release moved, so later work keeps its debt",
    () =>
      Effect.gen(function* () {
        yield* clear;
        const first = yield* take(start, 10);
        const second = yield* take(start, 20);
        yield* take(start, 5);
        yield* release(first, start);
        yield* release(second, later(9));
        expect(yield* busyFor(later(9))).toEqual(units(5));
      }),
  );

  test.effect("counts time a bill gave back as moving the reservations behind it", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* take(start, 10);
      const second = yield* take(start, 20);
      yield* take(start, 5);
      yield* adjust(start, -10);
      yield* release(second, later(9));
      expect(yield* busyFor(later(9))).toEqual(units(5));
    }),
  );

  test.effect("gives back too little rather than too much when time behind a reservation was given back first", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* take(start, 10);
      const second = yield* take(start, 20);
      const third = yield* take(start, 5);
      yield* release(third, start);
      yield* release(second, later(15));
      expect(yield* busyFor(later(15))).toEqual(units(5));
    }),
  );

  test.effect("releases nothing into a line new work recreated after the prune deleted the old one", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      const second = yield* take(start, 20);
      yield* release(first, start);
      yield* Db.Db.use((db) => db.rateLines.prune(later(21)));
      yield* take(later(21), 5);
      yield* release(second, later(22));
      expect(yield* busyFor(later(22))).toEqual(units(4));
    }),
  );

  test.effect("releases nothing once the prune deleted a paid-out line", () =>
    Effect.gen(function* () {
      yield* clear;
      const first = yield* take(start, 10);
      yield* Db.Db.use((db) => db.rateLines.prune(later(11)));
      yield* release(first, later(11));
      expect(yield* lines).toEqual([]);
    }),
  );

  test.effect("leaves a released line with no row clear", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* adjust(start, -40);
      expect(yield* busyFor(start)).toEqual(Duration.zero);
      expect(yield* reserve(start, 27)).toEqual(Option.some(start));
      expect(yield* busyFor(start)).toEqual(units(27));
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite rate lines", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres rate lines",
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

    test.effect("starts exactly 4 of 10 new logins one caller asks for at once", () =>
      Effect.gen(function* () {
        yield* clear;
        const starts = yield* Effect.all(
          Array.from({ length: 10 }, () => reserveNew("caller-a", start)),
          { concurrency: "unbounded" },
        );
        expect(starts.filter(Option.isSome).map((reserved) => reserved.value)).toEqual([start, start, start, start]);
        expect(yield* busyFor(start, caller("caller-a"))).toEqual(Duration.times(quarter, 4));
      }),
    );
  },
);
