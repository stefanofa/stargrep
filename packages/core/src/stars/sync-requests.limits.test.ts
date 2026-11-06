import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import * as TestDatabase from "@stargrep/db/test-database";
import { BudgetShare, type Login } from "@stargrep/github/schemas";
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
  fillNetwork,
  fullSynced,
  lineUnits,
  markFailed,
  memberId,
  memory,
  minute,
  networkUnits,
  octocat,
  org,
  owner,
  ownerId,
  request,
  reserveUnits,
  row,
  signedIn,
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

  it.effect("pays the line out at 80% of the budget share of 5,000 requests an hour", () =>
    Effect.gen(function* () {
      expect(SyncRequests.allRate(BudgetShare.make(0.5)).unitsPerHour).toBe(2_000);
      expect(SyncRequests.allRate(BudgetShare.make(0.25)).unitsPerHour).toBe(1_000);
      yield* admitting(
        ({ owners }) =>
          Effect.gen(function* () {
            owners.set("big-library", user("big-library", 7_001, 2_431));
            yield* request("big-library");
            expect(yield* lineUnits()).toBe(2 * 29);
          }),
        { share: BudgetShare.make(0.25) },
      );
    }),
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
        expect(sent.map((each) => each.mode)).toEqual(["incremental"]);
        expect(yield* lineUnits()).toBe(1 + 1 + 6);
      }),
    ),
  );

  it.effect("starts the owner's first sync now past a full line, on their own token, and leaves the line alone", () =>
    admitting(({ sent, delays }) =>
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
        expect(sent).toEqual([
          { login: "octocat" as Login, mode: "full", requestedAt: at(start), reserved: 0, userId: ownerId },
        ]);
        expect(yield* lineUnits()).toBe(4_500);
      }),
    ),
  );

  it.effect("leaves the next signed-out start where it was after the owner's sync", () =>
    admitting(() =>
      Effect.gen(function* () {
        yield* Db.Db.use((db) => db.accounts.upsertLooked(user("linus", 9004, 2_431)));
        yield* fill(300);
        yield* request("linus", owner);
        expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 101 * unitMillis) });
      }),
    ),
  );

  it.effect("starts a signed-in import of another login now past a full line, on the requester's token", () =>
    admitting(({ sent, delays }) =>
      Effect.gen(function* () {
        yield* fill(4_500);
        expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
        expect(yield* request("octocat", signedIn())).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
          ...octocat,
        });
        expect(delays).toEqual([Duration.zero]);
        expect(sent).toEqual([
          { login: "octocat" as Login, mode: "incremental", requestedAt: at(start), reserved: 0, userId: memberId },
        ]);
        expect(yield* lineUnits()).toBe(4_500 + 1);
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
  it.effect("charges a network a unit for each lookup, and a new login's first read on top", () =>
    admitting(({ owners }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 60 * minute);
        owners.set("github", org("github", 9919));
        yield* request("octocat");
        expect(yield* networkUnits()).toBe(1);
        yield* request("no-such-login").pipe(Effect.ignore);
        yield* request("github");
        expect(yield* networkUnits()).toBe(3);
        yield* request("hubot");
        expect(yield* networkUnits()).toBe(3 + 1 + 4);
        expect(yield* networkUnits("caller-b")).toBe(0);
      }),
    ),
  );

  it.effect(
    "puts a network in debt for a 100,000-star login, and refuses its next login while another network's starts",
    () =>
      admitting(({ lookups, owners }) =>
        Effect.gen(function* () {
          owners.set("huge", user("huge", 7_002, 100_000));
          expect(yield* request("huge")).toMatchObject({ state: "queued", starredTotal: 100_000 });
          expect(yield* networkUnits()).toBe(1 + 1_003);
          expect((yield* Effect.flip(request("hubot")))._tag).toBe("NewAccountLimited");
          expect(lookups).not.toContain("hubot" as Login);
          expect(yield* request("hubot", anyone("caller-b"))).toMatchObject({ state: "waiting" });

          yield* TestClock.adjust("5 hours");
          expect((yield* Effect.flip(request("grace")))._tag).toBe("NewAccountLimited");
          yield* TestClock.adjust("1 hour");
          expect(yield* request("grace")).toMatchObject({ state: "queued" });
        }),
      ),
  );

  it.effect("keeps a signed-in requester's network limits, because their import still pays its lookup", () =>
    admitting(({ owners, lookups }) =>
      Effect.gen(function* () {
        owners.set("huge", user("huge", 7_002, 100_000));
        expect(yield* request("huge", signedIn())).toMatchObject({ state: "queued", starredTotal: 100_000 });
        expect(yield* networkUnits()).toBe(1 + 1_003);
        expect(yield* lineUnits()).toBe(1);
        expect((yield* Effect.flip(request("hubot", signedIn())))._tag).toBe("NewAccountLimited");
        expect(lookups).toEqual(["huge" as Login]);
      }),
    ),
  );

  it.effect(
    "refuses a network that owes its burst before any lookup or claim, so another network queues the login",
    () =>
      admitting(({ sent, lookups }) =>
        Effect.gen(function* () {
          yield* fillNetwork(151);
          expect((yield* Effect.flip(request("swarm")))._tag).toBe("NewAccountLimited");
          expect(lookups).toEqual([]);
          expect(yield* row("swarm")).toEqual(Option.none());
          expect(yield* request("swarm", anyone("caller-b"))).toMatchObject({ state: "queued" });
          expect(sent.filter((each) => each.login === "swarm")).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "refuses a new login's first read once its lookup brings the network to its burst, and releases the claim",
    () =>
      admitting(({ sent, lookups }) =>
        Effect.gen(function* () {
          yield* fillNetwork(150);
          expect((yield* Effect.flip(request("hubot")))._tag).toBe("NewAccountLimited");
          expect(lookups).toEqual(["hubot" as Login]);
          expect(yield* row("hubot")).toEqual(Option.none());
          expect(yield* networkUnits()).toBe(151);
          expect(yield* lineUnits()).toBe(1);
          expect(sent).toEqual([]);
        }),
      ),
  );

  it.effect("gives a new login's first read back to its network when the line refuses it", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(request("hubot"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
          expect(yield* networkUnits()).toBe(1);
        }),
      { hooks: { duringLookup: (db) => reserveUnits(db, 4_500) } },
    ),
  );

  it.effect("keeps a network's debt after another network claims its new login again", () =>
    admitting(({ owners }) =>
      Effect.gen(function* () {
        owners.set("huge", user("huge", 7_002, 100_000));
        yield* request("huge");
        yield* markFailed("huge", start);
        yield* TestClock.adjust("11 minutes");
        expect(yield* request("huge", anyone("caller-b"))).toMatchObject({ state: "waiting" });
        expect((yield* Effect.flip(request("hubot")))._tag).toBe("NewAccountLimited");
      }),
    ),
  );
});

const concurrentCases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("starts one of several huge new logins one network asks for at once", () =>
    admitting(({ sent, lookups, owners }) =>
      Effect.gen(function* () {
        const logins = ["swarm", "hubot", "grace", "linus", "ada", "alan"];
        for (const [index, login] of logins.entries()) owners.set(login, user(login, 8_000 + index, 20_000));
        const results = yield* Effect.forEach(logins, (login) => Effect.result(request(login)), {
          concurrency: "unbounded",
        });
        const outcomes = results.map((result) =>
          result._tag === "Success" ? result.success.state : result.failure._tag,
        );
        expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "NewAccountLimited")).toHaveLength(5);
        expect(sent).toHaveLength(1);
        expect(yield* networkUnits()).toBe(lookups.length + 203);
      }),
    ),
  );
};

it.layer(memory, { timeout: 30_000 })("PGlite SyncRequests limits at once", concurrentCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 30_000 })(
  "node-postgres SyncRequests limits at once",
  concurrentCases,
);
