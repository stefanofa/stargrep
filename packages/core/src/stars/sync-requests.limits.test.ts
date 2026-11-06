import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import * as TestDatabase from "@stargrep/db/test-database";
import type { Login } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  admitting,
  anyone,
  at,
  embeddingModel,
  fill,
  finished,
  fullSynced,
  lineUnits,
  markFailed,
  memory,
  minute,
  octocat,
  owner,
  request,
  reserveUnits,
  row,
  start,
  status,
  synced,
  unitMillis,
  units,
  user,
} from "./sync-requests.fixture.ts";
import * as SyncRequests from "./sync-requests.ts";

it.layer(memory, { timeout: 30_000 })("SyncRequests line", (it) => {
  it.effect("queues a new user inside the burst with no delay, stores its starred total, and pays its cost", () =>
    admitting(({ delays, owners }) =>
      Effect.gen(function* () {
        owners.set("big-library", user("big-library", 7_001, 2_431));
        expect(yield* request("big-library")).toMatchObject({ state: "queued", starredTotal: 2_431 });
        expect(delays).toEqual([Duration.zero]);
        expect(yield* lineUnits()).toBe(29);
        const stored = yield* Db.Db.use((db) => db.accounts.byLogin("big-library" as Login));
        expect(Option.map(stored, (found) => found.starredCount)).toEqual(Option.some(2_431));
      }),
    ),
  );

  it.effect("makes a sync past the burst wait in line, sends it delayed, and reads it queued once it starts", () =>
    admitting(({ delays }) =>
      Effect.gen(function* () {
        yield* fill(300);
        const startsAt = at(start + 101 * unitMillis);
        expect(yield* request("octocat")).toEqual({
          state: "waiting",
          requestedAt: at(start),
          startsAt,
          ahead: 0,
          syncedAt: null,
          ...octocat,
        });
        expect(delays).toEqual([units(101)]);
        expect(yield* row("octocat")).toMatchObject(Option.some({ outcome: "pending", startsAt }));

        expect(yield* request("hubot", anyone("caller-b"))).toMatchObject({ state: "waiting", ahead: 1 });
        expect(yield* status("octocat")).toMatchObject({ state: "waiting", ahead: 0 });
        expect(yield* status("hubot")).toMatchObject({ state: "waiting", ahead: 1 });

        yield* TestClock.adjust(units(101));
        expect(yield* status("octocat")).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
          ...octocat,
        });
        expect(yield* status("hubot")).toMatchObject({ state: "waiting", ahead: 0 });
      }),
    ),
  );

  it.effect("holds a waiting login until 10 minutes after it starts, so it sends one message", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* fill(300);
        yield* request("octocat");
        yield* TestClock.adjust("10 minutes");
        expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
        yield* TestClock.adjust(units(100));
        expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
        expect(sent).toHaveLength(1);
        yield* TestClock.adjust(units(1));
        expect(yield* request("octocat")).toMatchObject({
          state: "queued",
          requestedAt: at(start + 10 * minute + 101 * unitMillis),
        });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("refuses a full line before any lookup, and takes nothing from it or from the network", () =>
    admitting(({ lookups }) =>
      Effect.gen(function* () {
        yield* fill(4_500);
        expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
        expect(lookups).toEqual([]);
        expect(yield* lineUnits()).toBe(4_500);
        expect(yield* lineUnits(Db.callerLine(Db.CallerKey.make("caller-a")))).toBe(0);
        expect(yield* row("octocat")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("releases the claim when the line fills during the lookup, and still pays the lookup", () =>
    admitting(
      ({ sent }) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
          expect(yield* lineUnits()).toBe(4_501);
          expect(yield* row("octocat")).toEqual(Option.none());
          expect(sent).toEqual([]);
        }),
      { hooks: { duringLookup: (db) => reserveUnits(db, 4_500) } },
    ),
  );

  it.effect("pays a missing login's lookup into the line, even when the line is past its limit", () =>
    Effect.gen(function* () {
      yield* admitting(() =>
        Effect.gen(function* () {
          yield* request("no-such-login").pipe(Effect.ignore);
          expect(yield* lineUnits()).toBe(1);
        }),
      );
      yield* admitting(
        () =>
          Effect.gen(function* () {
            yield* fill(4_000);
            expect((yield* Effect.flip(request("another-missing-login")))._tag).toBe("LoginNotFound");
            expect(yield* lineUnits()).toBe(4_000 + 500 + 1);
          }),
        { hooks: { duringLookup: (db) => reserveUnits(db, 500) } },
      );
    }),
  );

  it.effect("prices a known account's star pages by the stars added since those it stored", () =>
    admitting(({ sent, owners }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 60 * minute);
        yield* fullSynced(start - 60 * minute);
        owners.set("octocat", user("octocat", 583231, 542));
        yield* request("octocat");
        expect(yield* lineUnits()).toBe(1 + 1 + 6);

        yield* TestClock.adjust("10 minutes");
        yield* request("octocat", owner);
        expect(sent.map((each) => each.mode)).toEqual(["incremental", "incremental"]);
        expect(yield* lineUnits()).toBe(1 + 6);
      }),
    ),
  );

  it.effect("starts the owner's first sync now past a full line, and moves the line by its cost", () =>
    admitting(({ delays }) =>
      Effect.gen(function* () {
        yield* Db.Db.use((db) => db.accounts.upsertLooked(user("octocat", 583231, 2_431)));
        yield* fill(4_500);
        expect(yield* request("octocat", owner)).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
          starredTotal: 2_431,
          accountType: "user",
        });
        expect(delays).toEqual([Duration.zero]);
        expect(yield* lineUnits()).toBe(4_500 + 28);
      }),
    ),
  );

  it.effect("pushes the next signed-out start later by what the owner's sync costs", () =>
    admitting(() =>
      Effect.gen(function* () {
        yield* Db.Db.use((db) => db.accounts.upsertLooked(user("linus", 9004, 2_431)));
        yield* fill(300);
        yield* request("linus", owner);
        expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 129 * unitMillis) });
      }),
    ),
  );

  it.effect("prunes requests older than a day and lines the clock has passed, and keeps the rest", () =>
    admitting(() =>
      Effect.gen(function* () {
        yield* request("octocat");
        yield* TestClock.adjust("23 hours");
        yield* request("hubot", anyone("caller-b"));
        yield* TestClock.adjust("2 hours");
        yield* fill(10);
        yield* SyncRequests.prune();
        expect(yield* row("octocat")).toEqual(Option.none());
        expect(Option.isSome(yield* row("hubot"))).toBe(true);
        const keys = yield* (yield* TestDatabase.TestDatabase).query("select key from rate_lines order by key");
        expect(keys).toEqual([{ key: "all" }]);
      }),
    ),
  );
});

it.layer(memory, { timeout: 30_000 })("SyncRequests network limit", (it) => {
  it.effect("starts 4 new logins for one caller, missing logins included, then one every 15 minutes", () =>
    admitting(({ lookups }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 60 * minute);
        for (const login of ["hubot", "grace", "linus"]) yield* request(login);
        yield* request("missing-one").pipe(Effect.ignore);
        expect((yield* Effect.flip(request("ada")))._tag).toBe("NewAccountLimited");
        expect(lookups).not.toContain("ada" as Login);
        expect(yield* row("ada")).toEqual(Option.none());
        expect(yield* request("octocat")).toMatchObject({ state: "queued" });
        expect(yield* request("ada", anyone("caller-b"))).toMatchObject({ state: "queued" });

        yield* TestClock.adjust("14 minutes");
        expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
        yield* TestClock.adjust("1 minute");
        expect(yield* request("alan")).toMatchObject({ state: "queued" });
        expect((yield* Effect.flip(request("swarm")))._tag).toBe("NewAccountLimited");
      }),
    ),
  );

  it.effect("keeps counting a caller's new logins after they sync and the caller asks for them again", () =>
    admitting(({ lookups }) =>
      Effect.gen(function* () {
        const first = ["swarm", "hubot", "grace", "linus"];
        for (const login of first) yield* request(login);
        yield* TestClock.adjust("1 minute");
        for (const login of first) yield* finished(login);
        yield* TestClock.adjust("10 minutes");
        for (const login of first) expect(yield* request(login)).toMatchObject({ state: "queued" });
        expect((yield* Effect.flip(request("ada")))._tag).toBe("NewAccountLimited");
        expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
        expect(lookups).toHaveLength(8);
      }),
    ),
  );

  it.effect("keeps counting a caller's new logins after another caller claims them again", () =>
    admitting(() =>
      Effect.gen(function* () {
        const first = ["hubot", "grace", "linus", "ada"];
        for (const login of first) {
          yield* request(login);
          yield* markFailed(login, start);
        }
        yield* TestClock.adjust("11 minutes");
        for (const login of first) {
          expect(yield* request(login, anyone("caller-b"))).toMatchObject({ state: "queued" });
        }
        expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
      }),
    ),
  );

  it.effect("refuses an over-limit network before it claims, so another network's trigger queues the login", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        for (const login of ["hubot", "grace", "linus", "ada"]) yield* request(login);
        expect((yield* Effect.flip(request("swarm")))._tag).toBe("NewAccountLimited");
        expect(yield* row("swarm")).toEqual(Option.none());
        expect(yield* request("swarm", anyone("caller-b"))).toMatchObject({ state: "queued" });
        expect(sent.filter((each) => each.login === "swarm")).toHaveLength(1);
      }),
    ),
  );
});

const concurrentCases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("starts only 4 of 6 new logins one caller asks for at once", () =>
    admitting(({ sent, lookups }) =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(
          ["swarm", "hubot", "grace", "linus", "ada", "alan"],
          (login) => Effect.result(request(login)),
          { concurrency: "unbounded" },
        );
        const outcomes = results.map((result) =>
          result._tag === "Success" ? result.success.state : result.failure._tag,
        );
        expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(4);
        expect(outcomes.filter((outcome) => outcome === "NewAccountLimited")).toHaveLength(2);
        expect(lookups).toHaveLength(4);
        expect(sent).toHaveLength(4);
      }),
    ),
  );
};

it.layer(memory, { timeout: 30_000 })("PGlite SyncRequests limits at once", concurrentCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 30_000 })(
  "node-postgres SyncRequests limits at once",
  concurrentCases,
);
