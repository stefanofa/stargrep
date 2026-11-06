import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import type { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { Owner } from "@stargrep/github/owner";
import type { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as OwnerLookup from "./owner-lookup.ts";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequests from "./sync-requests.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const start = Date.parse("2026-11-04T12:00:00Z");
const minute = 60_000;
const unitMillis = 1_800;
const queue = SyncQueue.layerMemory();
const github = OwnerLookup.layerMemory();

// Runs before each lookup reaches the memory layer, so a test can fail a lookup or fill the line meanwhile.
const duringLookup: {
  run: (db: Db.Db["Service"]) => Effect.Effect<void, OwnerLookup.OwnerLookupFailed | SyncRequests.SyncBusy>;
} = {
  run: () => Effect.void,
};

const lookups = Layer.effect(
  OwnerLookup.OwnerLookup,
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const memory = yield* OwnerLookup.OwnerLookup;
    return OwnerLookup.OwnerLookup.of({
      lookup: (login) => Effect.suspend(() => duringLookup.run(db)).pipe(Effect.andThen(memory.lookup(login))),
    });
  }),
).pipe(Layer.provide(github.layer));

// Runs each claim, so a test can line the claims up and hold the ones that lose.
const claiming: { run: (claim: Effect.Effect<boolean, DbQueryFailed>) => Effect.Effect<boolean, DbQueryFailed> } = {
  run: (claim) => claim,
};

const claims = Layer.effect(
  Db.Db,
  Effect.map(Db.Db, (db) =>
    Db.Db.of({
      ...db,
      syncRequests: {
        ...db.syncRequests,
        claim: (claim) => Effect.suspend(() => claiming.run(db.syncRequests.claim(claim))),
      },
    }),
  ),
);

const memory = TestDatabase.layerMemory({ embeddingModel });

const layerWith = <E>(
  sender: Layer.Layer<SyncQueue.SyncQueue>,
  database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>,
) =>
  SyncRequests.layer.pipe(
    Layer.provide(claims),
    Layer.provideMerge(lookups),
    Layer.provideMerge(database),
    Layer.provideMerge(sender),
  );

const at = (millis: number) => DateTime.makeUnsafe(millis);
const units = (count: number) => Duration.millis(count * unitMillis);

const user = (login: string, id: number, starredTotal: number): Owner => ({
  account: {
    id: id as GitHubAccountId,
    login: login as Login,
    type: "user",
    name: null,
    avatarUrl: null,
    followers: 1,
    publicRepos: 2,
  },
  starredTotal,
});

const org = (login: string, id: number): Owner => ({
  account: { ...user(login, id, 0).account, type: "org", followers: null },
  starredTotal: 0,
});

const octocat = { starredTotal: 42, accountType: "user" } as const;
const signedUp = { starredTotal: null, accountType: "user" } as const;

const reset = Effect.gen(function* () {
  queue.sent.length = 0;
  queue.delays.length = 0;
  github.lookups.length = 0;
  github.owners.clear();
  duringLookup.run = () => Effect.void;
  claiming.run = (claim) => claim;
  for (const [index, login] of ["octocat", "swarm", "hubot", "grace", "linus", "ada", "alan"].entries()) {
    github.owners.set(login, user(login, login === "octocat" ? 583231 : 9000 + index, 42));
  }
  yield* (yield* TestDatabase.TestDatabase).query("truncate github_accounts, sync_requests, sync_lines cascade");
  yield* TestClock.setTime(start);
});

const synced = (login: string, syncedAt: number) =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const accountId = 583231 as GitHubAccountId;
    yield* db.accounts.upsert({
      id: accountId,
      type: "user",
      login: login as Login,
      name: null,
      avatarUrl: null,
      followers: null,
      publicRepos: null,
    });
    yield* db.accounts.recordStarSync({ accountId, etag: null, at: at(syncedAt) });
  });

const finished = (login: string) =>
  Effect.flatMap(DateTime.now, (now) =>
    Db.Db.use((db) =>
      Effect.flatMap(db.accounts.byLogin(login as Login), (account) =>
        db.accounts.recordStarSync({ accountId: Option.getOrThrow(account).id, etag: null, at: now }),
      ),
    ),
  );

const markFailed = (login: string, requestedAt: number) =>
  Db.Db.use((db) => db.syncRequests.settle(login as Login, at(requestedAt), "failed"));

const anyone = (caller = "caller-a"): SyncRequests.Requester => ({ _tag: "anyone", caller: Db.CallerKey.make(caller) });
const owner: SyncRequests.Requester = { _tag: "owner" };

const request = (login: string, by: SyncRequests.Requester = anyone()) =>
  SyncRequests.SyncRequests.use((service) => service.request(login as Login, by));

const fullSynced = (syncedAt: number) =>
  Db.Db.use((db) => db.stars.applySnapshot({ accountId: 583231 as GitHubAccountId, stars: [], at: at(syncedAt) }));

const modes = () => queue.sent.map((sent) => sent.mode);
const status = (login: string) => SyncRequests.SyncRequests.use((service) => service.status(login as Login));
const row = (login: string) => Db.Db.use((db) => db.syncRequests.get(login as Login));

// How many units the line holds past now.
const lineUnits = Effect.flatMap(DateTime.now, (now) =>
  Db.Db.use((db) => db.syncLine.wait("all", now, Duration.zero)).pipe(
    Effect.map((wait) => Duration.toMillis(wait) / unitMillis),
  ),
);

const reserveUnits = (db: Db.Db["Service"], count: number) =>
  Effect.flatMap(DateTime.now, (now) =>
    db.syncLine.reserve({
      line: "all",
      at: now,
      cost: units(count),
      tolerance: units(200),
      maxWait: Duration.hours(2),
      force: true,
    }),
  ).pipe(Effect.orDie, Effect.asVoid);

const fill = (count: number) => Db.Db.use((db) => reserveUnits(db, count));

const admitted = (decision: string) =>
  Effect.map(Metric.value(Metric.withAttributes(SyncRequests.admissions, { decision })), (state) => state.count);

it.layer(layerWith(queue.layer, memory), { timeout: 30_000 })("SyncRequests", (it) => {
  it.effect("queues an unknown login once and reports it done after a later sync", () =>
    Effect.gen(function* () {
      yield* reset;
      expect(yield* status("octocat")).toEqual({ state: "unknown", starredTotal: null, accountType: null });
      expect(yield* request("octocat")).toEqual({
        state: "queued",
        requestedAt: at(start),
        syncedAt: null,
        ...octocat,
      });
      yield* TestClock.adjust("1 minute");
      expect(yield* request("OctoCat")).toEqual({
        state: "queued",
        requestedAt: at(start),
        syncedAt: null,
        ...octocat,
      });
      expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "incremental", requestedAt: at(start) }]);

      yield* synced("octocat", start + 30_000);
      expect(yield* status("Octocat")).toEqual({ state: "done", syncedAt: at(start + 30_000), ...octocat });
    }),
  );

  it.effect("looks up and queues one job when the same login is triggered many times at once", () =>
    Effect.gen(function* () {
      yield* reset;
      const answers = yield* Effect.all(
        Array.from({ length: 6 }, (_, index) => request("swarm", anyone(`caller-${index}`))),
        { concurrency: "unbounded" },
      );
      expect(queue.sent).toHaveLength(1);
      expect(github.lookups).toEqual(["swarm" as Login]);
      expect(answers.every((answer) => answer.state === "queued")).toBe(true);
    }),
  );

  it.effect("sends again once the cooldown passes and the earlier request never finished", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat");
      yield* TestClock.adjust("11 minutes");
      const later = start + 11 * minute;
      expect(yield* request("octocat")).toEqual({
        state: "queued",
        requestedAt: at(later),
        syncedAt: null,
        ...octocat,
      });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("answers a login synced inside the cooldown without sending, and syncs it again after", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 5 * minute);
      expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 5 * minute), ...signedUp });
      expect(queue.sent).toEqual([]);

      yield* TestClock.adjust("6 minutes");
      expect(yield* request("octocat")).toEqual({
        state: "queued",
        requestedAt: at(start + 6 * minute),
        syncedAt: at(start - 5 * minute),
        ...octocat,
      });
      expect(queue.sent).toHaveLength(1);
    }),
  );

  it.effect("reports a dead-lettered request as failed and queues it again only after the cooldown", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("hubot");
      yield* TestClock.adjust("1 minute");
      yield* markFailed("HuBot", start);
      const failed = { state: "failed", requestedAt: at(start), syncedAt: null, ...octocat } as const;
      expect(yield* status("hubot")).toEqual(failed);
      expect(yield* request("hubot")).toEqual(failed);
      expect(queue.sent).toHaveLength(1);

      yield* TestClock.adjust("10 minutes");
      expect(yield* request("hubot")).toMatchObject({ state: "queued" });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("keeps a fresh request queued when the dead letter of an older one arrives", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat");
      yield* TestClock.adjust("11 minutes");
      const fresh = yield* request("octocat");
      yield* markFailed("octocat", start);
      expect(yield* status("octocat")).toEqual(fresh);
      expect(fresh).toMatchObject({ state: "queued", requestedAt: at(start + 11 * minute) });
    }),
  );

  it.effect("queues the owner's library open a minute after a sync that anyone has to wait 10 minutes for", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 2 * minute);
      yield* fullSynced(start - 2 * minute);
      expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 2 * minute), ...signedUp });
      expect(yield* request("octocat", owner)).toEqual({
        state: "queued",
        requestedAt: at(start),
        syncedAt: at(start - 2 * minute),
        ...signedUp,
      });
      expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "incremental", requestedAt: at(start) }]);
      expect(github.lookups).toEqual([]);
    }),
  );

  it.effect("bounds the owner to one sync a minute after the last one finished", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 30_000);
      yield* fullSynced(start - 30_000);
      expect(yield* request("octocat", owner)).toEqual({ state: "done", syncedAt: at(start - 30_000), ...signedUp });
      expect(queue.sent).toEqual([]);

      yield* TestClock.adjust("30 seconds");
      expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
      yield* TestClock.adjust("70 seconds");
      expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
      yield* synced("octocat", start + 90_000);
      expect(yield* request("octocat", owner)).toEqual({ state: "done", syncedAt: at(start + 90_000), ...signedUp });
      expect(queue.sent).toHaveLength(1);

      yield* TestClock.adjust("50 seconds");
      expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 150_000) });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect(
    "makes the owner wait 10 minutes for a first sync still reading, instead of starting a second full read",
    () =>
      Effect.gen(function* () {
        yield* reset;
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
        yield* TestClock.adjust("61 seconds");
        expect(yield* request("octocat", owner)).toMatchObject({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
        });
        yield* TestClock.adjust("8 minutes");
        yield* TestClock.adjust("58 seconds");
        yield* request("octocat", owner);
        expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "full", requestedAt: at(start) }]);

        yield* TestClock.adjust("1 second");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 600_000) });
        expect(queue.sent).toHaveLength(2);
      }),
  );

  it.effect("queues the owner's sync now over anyone's request still waiting in line", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(4_000);
      expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 3_800 * unitMillis) });
      yield* TestClock.adjust("15 minutes");
      const opened = { state: "queued", requestedAt: at(start + 15 * minute), syncedAt: null, ...octocat } as const;
      expect(yield* request("octocat", owner)).toEqual(opened);
      expect(queue.delays).toEqual([units(3_800), Duration.zero]);
      expect(queue.sent[1]).toEqual({
        login: "octocat" as Login,
        mode: "incremental",
        requestedAt: at(start + 15 * minute),
      });
      expect(yield* status("octocat")).toEqual(opened);

      yield* TestClock.adjust("1 minute");
      expect(yield* request("octocat", owner)).toEqual(opened);
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("makes the owner wait for anyone's request that is queued and no longer waiting", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(300);
      expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 100 * unitMillis) });
      yield* TestClock.adjust(units(100));
      yield* TestClock.adjust("9 minutes");
      expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* request("octocat", owner)).toMatchObject({
        state: "queued",
        requestedAt: at(start + 100 * unitMillis + 10 * minute),
      });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("keeps the 10-minute wait for anyone after the owner's request", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat", owner);
      yield* TestClock.adjust("9 minutes");
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start + 10 * minute) });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect(
    "sends the owner a full sync once the last full read is a week old, and never while a request is queued",
    () =>
      Effect.gen(function* () {
        yield* reset;
        yield* synced("octocat", start - 60 * minute);
        yield* fullSynced(start - 6 * 24 * 60 * minute);
        yield* request("octocat", owner);
        expect(modes()).toEqual(["incremental"]);

        yield* synced("octocat", start + 5_000);
        yield* TestClock.adjust("1 day");
        yield* request("octocat", owner);
        expect(modes()).toEqual(["incremental", "full"]);

        yield* TestClock.adjust("2 minutes");
        yield* request("octocat", owner);
        expect(modes()).toEqual(["incremental", "full"]);

        yield* TestClock.adjust("8 minutes");
        yield* request("octocat", owner);
        expect(modes()).toEqual(["incremental", "full", "incremental"]);

        const fullRequest = start + 24 * 60 * minute;
        yield* fullSynced(fullRequest + 1_000);
        yield* synced("octocat", fullRequest + 10 * minute + 1_000);
        yield* TestClock.adjust("2 minutes");
        yield* request("octocat", owner);
        expect(modes()).toEqual(["incremental", "full", "incremental", "incremental"]);
      }),
  );

  it.effect("never sends a full sync for anyone", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 60 * minute);
      yield* request("octocat");
      expect(modes()).toEqual(["incremental"]);
    }),
  );

  it.effect("forgets a request after a day", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat");
      yield* TestClock.adjust("25 hours");
      expect(yield* status("octocat")).toEqual({ state: "unknown", ...octocat });
    }),
  );

  it.effect("answers a login GitHub does not have as not found, from the claim row for 10 minutes", () =>
    Effect.gen(function* () {
      yield* reset;
      for (const _ of [1, 2]) {
        expect(yield* Effect.flip(request("no-such-login"))).toMatchObject({
          _tag: "LoginNotFound",
          login: "no-such-login",
        });
      }
      expect(github.lookups).toEqual(["no-such-login" as Login]);
      expect(queue.sent).toEqual([]);
      expect(yield* status("no-such-login")).toEqual({ state: "unknown", starredTotal: null, accountType: null });

      yield* TestClock.adjust("9 minutes");
      expect((yield* Effect.flip(request("no-such-login")))._tag).toBe("LoginNotFound");
      expect(github.lookups).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect((yield* Effect.flip(request("no-such-login")))._tag).toBe("LoginNotFound");
      expect(github.lookups).toHaveLength(2);
    }),
  );

  it.effect("pays a missing login's lookup into the line, even when the line is past its limit", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("no-such-login").pipe(Effect.ignore);
      expect(yield* lineUnits).toBe(1);

      yield* fill(4_000);
      const before = yield* lineUnits;
      duringLookup.run = (db) => reserveUnits(db, 500);
      expect((yield* Effect.flip(request("another-missing-login")))._tag).toBe("LoginNotFound");
      expect(yield* lineUnits).toBe(before + 500 + 1);
    }),
  );

  it.effect("answers an org done with a starred total of 0, sends nothing, and pays only its lookup", () =>
    Effect.gen(function* () {
      yield* reset;
      github.owners.set("github", org("github", 9919));
      expect(yield* request("github")).toEqual({
        state: "done",
        syncedAt: at(start),
        starredTotal: 0,
        accountType: "org",
      });
      expect(queue.sent).toEqual([]);
      expect(yield* lineUnits).toBe(1);
      expect(yield* status("GitHub")).toEqual({
        state: "done",
        syncedAt: at(start),
        starredTotal: 0,
        accountType: "org",
      });
    }),
  );

  it.effect("queues a new user inside the burst with no delay, stores its starred total, and pays its cost", () =>
    Effect.gen(function* () {
      yield* reset;
      github.owners.set("big-library", user("big-library", 7_001, 2_431));
      expect(yield* request("big-library")).toMatchObject({ state: "queued", starredTotal: 2_431 });
      expect(queue.delays).toEqual([Duration.zero]);
      expect(yield* lineUnits).toBe(27);
      const stored = yield* Db.Db.use((db) => db.accounts.byLogin("big-library" as Login));
      expect(Option.map(stored, (found) => found.starredCount)).toEqual(Option.some(2_431));
    }),
  );

  it.effect("makes a sync past the burst wait in line, sends it delayed, and reads it queued once it starts", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(300);
      const startsAt = at(start + 100 * unitMillis);
      expect(yield* request("octocat")).toEqual({
        state: "waiting",
        requestedAt: at(start),
        startsAt,
        ahead: 0,
        syncedAt: null,
        ...octocat,
      });
      expect(queue.delays).toEqual([units(100)]);
      expect(Option.map(yield* row("octocat"), (stored) => stored.startsAt)).toEqual(Option.some(startsAt));

      expect(yield* request("hubot", anyone("caller-b"))).toMatchObject({ state: "waiting", ahead: 1 });
      expect(yield* status("octocat")).toMatchObject({ state: "waiting", ahead: 0 });
      expect(yield* status("hubot")).toMatchObject({ state: "waiting", ahead: 1 });

      yield* TestClock.adjust(units(100));
      expect(yield* status("octocat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null, ...octocat });
      expect(yield* status("hubot")).toMatchObject({ state: "waiting", ahead: 0 });
    }),
  );

  it.effect("holds a waiting login until 10 minutes after it starts, so it sends one message", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(300);
      yield* request("octocat");
      yield* TestClock.adjust("10 minutes");
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
      yield* TestClock.adjust(units(99));
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust(units(1));
      expect(yield* request("octocat")).toMatchObject({
        state: "queued",
        requestedAt: at(start + 10 * minute + 100 * unitMillis),
      });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("refuses a full line before any lookup, and takes nothing from it", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(4_500);
      expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
      expect(github.lookups).toEqual([]);
      expect(yield* lineUnits).toBe(4_500);
      expect(yield* row("octocat")).toEqual(Option.none());
    }),
  );

  it.effect("releases the claim when the line fills during the lookup, and still pays the lookup", () =>
    Effect.gen(function* () {
      yield* reset;
      duringLookup.run = (db) => reserveUnits(db, 4_500);
      expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
      expect(yield* lineUnits).toBe(4_501);
      expect(yield* row("octocat")).toEqual(Option.none());
      expect(queue.sent).toEqual([]);

      duringLookup.run = () => Effect.void;
      claiming.run = (claim) => claim;
      yield* TestClock.adjust(units(4_501));
      expect(yield* request("octocat")).toMatchObject({ state: "queued" });
    }),
  );

  it.effect("starts 4 new logins for one caller, missing logins included, then one every 15 minutes", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 60 * minute);
      for (const login of ["hubot", "grace", "linus"]) yield* request(login);
      yield* request("missing-one").pipe(Effect.ignore);
      expect((yield* Effect.flip(request("ada")))._tag).toBe("NewAccountLimited");
      expect(github.lookups).not.toContain("ada" as Login);
      expect(yield* row("ada")).toEqual(Option.none());
      expect(yield* request("octocat")).toMatchObject({ state: "queued" });
      expect(yield* request("ada", anyone("caller-b"))).toMatchObject({ state: "queued" });

      yield* TestClock.adjust("14 minutes");
      expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
      yield* TestClock.adjust("1 minute");
      expect(yield* request("alan")).toMatchObject({ state: "queued" });
      expect((yield* Effect.flip(request("swarm")))._tag).toBe("NewAccountLimited");
    }),
  );

  it.effect("keeps counting a caller's new logins after they sync and the caller asks for them again", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = ["swarm", "hubot", "grace", "linus"];
      for (const login of first) yield* request(login);
      yield* TestClock.adjust("1 minute");
      for (const login of first) yield* finished(login);
      yield* TestClock.adjust("10 minutes");
      for (const login of first) expect(yield* request(login)).toMatchObject({ state: "queued" });
      expect((yield* Effect.flip(request("ada")))._tag).toBe("NewAccountLimited");
      expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
      expect(github.lookups).toHaveLength(8);
    }),
  );

  it.effect("keeps counting a caller's new logins after another caller claims them again", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = ["hubot", "grace", "linus", "ada"];
      for (const login of first) {
        yield* request(login);
        yield* markFailed(login, start);
      }
      yield* TestClock.adjust("11 minutes");
      for (const login of first) expect(yield* request(login, anyone("caller-b"))).toMatchObject({ state: "queued" });
      expect((yield* Effect.flip(request("alan")))._tag).toBe("NewAccountLimited");
    }),
  );

  it.effect("prices a known account's star pages by the stars added since those it stored", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 60 * minute);
      yield* fullSynced(start - 60 * minute);
      github.owners.set("octocat", user("octocat", 583231, 542));
      yield* request("octocat");
      expect(yield* lineUnits).toBe(1 + 1 + 6);

      yield* TestClock.adjust("10 minutes");
      yield* request("octocat", owner);
      expect(modes()).toEqual(["incremental", "incremental"]);
      expect(yield* lineUnits).toBe(1 + 6);
    }),
  );

  it.effect("starts the owner's first sync now past a full line, and moves the line by its cost", () =>
    Effect.gen(function* () {
      yield* reset;
      const facts = user("octocat", 583231, 2_431).account;
      yield* Db.Db.use((db) => db.accounts.upsert(facts, 2_431));
      yield* fill(4_500);
      expect(yield* request("octocat", owner)).toEqual({
        state: "queued",
        requestedAt: at(start),
        syncedAt: null,
        starredTotal: 2_431,
        accountType: "user",
      });
      expect(queue.delays).toEqual([Duration.zero]);
      expect(yield* lineUnits).toBe(4_500 + 26);
    }),
  );

  it.effect("pushes the next signed-out start later by what the owner's sync costs", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* Db.Db.use((db) => db.accounts.upsert(user("linus", 9004, 2_431).account, 2_431));
      yield* fill(300);
      yield* request("linus", owner);
      expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 126 * unitMillis) });
    }),
  );

  it.effect("releases the claim on a failed lookup, and fails a spent GitHub budget as busy", () =>
    Effect.gen(function* () {
      yield* reset;
      duringLookup.run = () => Effect.fail(new OwnerLookup.OwnerLookupFailed({ reason: "timeout" }));
      expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "OwnerLookupFailed", reason: "timeout" });
      expect(yield* row("octocat")).toEqual(Option.none());

      duringLookup.run = () => Effect.fail(new SyncRequests.SyncBusy({ reason: "github-budget" }));
      expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "SyncBusy", reason: "github-budget" });
      expect(yield* row("octocat")).toEqual(Option.none());
      expect(yield* lineUnits).toBe(0);

      duringLookup.run = () => Effect.void;
      claiming.run = (claim) => claim;
      expect(yield* request("octocat")).toMatchObject({ state: "queued" });
    }),
  );

  it.effect("counts each decision and marks the span with no login or caller in any attribute", () =>
    Effect.gen(function* () {
      yield* reset;
      const [started, notFound] = [yield* admitted("started"), yield* admitted("not-found")];
      const collected = collectSpans();
      yield* request("octocat").pipe(Effect.withTracer(collected.tracer));
      yield* request("no-such-login").pipe(Effect.ignore, Effect.withTracer(collected.tracer));
      expect(yield* admitted("started")).toBe(started + 1);
      expect(yield* admitted("not-found")).toBe(notFound + 1);
      const span = collected.named("SyncRequests.request");
      expect(span?.attributes.get("sync.admission.decision")).toBe("started");
      expect(span?.attributes.get("sync.admission.cost")).toBe(3);
      expect(span?.attributes.get("sync.admission.wait_seconds")).toBe(0);
      const attributes = collected.spans.flatMap((each) => [...each.attributes.values()].map(String));
      expect(attributes.join(" ")).not.toMatch(/octocat|no-such-login|caller-a/);
    }),
  );
});

const concurrentCases = (test: {
  readonly effect: it.Tester<SyncRequests.SyncRequests | Db.Db | TestDatabase.TestDatabase>;
}) => {
  test.effect("starts only 4 of 6 new logins one caller asks for at once", () =>
    Effect.gen(function* () {
      yield* reset;
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
      expect(github.lookups).toHaveLength(4);
      expect(queue.sent).toHaveLength(4);
    }),
  );

  test.effect("answers every trigger for a login GitHub does not have not found, after one lookup", () =>
    Effect.gen(function* () {
      yield* reset;
      const arrived = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      let claimed = 0;
      claiming.run = (claim) =>
        Effect.gen(function* () {
          claimed += 1;
          if (claimed === 3) yield* Deferred.succeed(arrived, undefined);
          yield* Deferred.await(arrived);
          const won = yield* claim;
          if (!won) yield* Deferred.await(settled);
          return won;
        });
      const results = yield* Effect.forEach(
        ["caller-0", "caller-1", "caller-2"],
        (caller) =>
          Effect.result(request("missing-login", anyone(caller))).pipe(
            Effect.ensuring(Deferred.succeed(settled, undefined)),
          ),
        { concurrency: "unbounded" },
      );
      const outcomes = results.map((result) =>
        result._tag === "Success" ? result.success.state : result.failure._tag,
      );
      expect(outcomes).toEqual(["LoginNotFound", "LoginNotFound", "LoginNotFound"]);
      expect(github.lookups).toEqual(["missing-login" as Login]);
      expect(queue.sent).toEqual([]);
    }),
  );
};

it.layer(layerWith(queue.layer, memory), { timeout: 30_000 })("PGlite SyncRequests at once", concurrentCases);
it.layer(layerWith(queue.layer, TestDatabase.layerNodePostgres({ embeddingModel })), { timeout: 30_000 })(
  "node-postgres SyncRequests at once",
  concurrentCases,
);

it.effect("prices the GitHub requests a sync makes", () =>
  Effect.sync(() => {
    const since = (starredTotal: number, storedStars: number) =>
      ({ _tag: "since", starredTotal, storedStars }) as const;
    expect(SyncRequests.lookupCost).toBe(1);
    expect(SyncRequests.costOf(true, since(2_431, 2_431))).toBe(3);
    expect(SyncRequests.costOf(true, since(2_431, 2_500))).toBe(3);
    expect(SyncRequests.costOf(true, since(2_431, 2_332))).toBe(3);
    expect(SyncRequests.costOf(true, since(2_431, 2_331))).toBe(4);
    expect(SyncRequests.costOf(true, since(501, 1))).toBe(8);
    expect(SyncRequests.costOf(false, since(501, 1))).toBe(7);
    expect(SyncRequests.costOf(true, { _tag: "every", starredTotal: 0 })).toBe(3);
    expect(SyncRequests.costOf(true, { _tag: "every", starredTotal: 2_431 })).toBe(27);
    expect(SyncRequests.costOf(false, { _tag: "every", starredTotal: 2_431 })).toBe(26);
  }),
);

const brokenQueue = Layer.succeed(
  SyncQueue.SyncQueue,
  SyncQueue.SyncQueue.of({ send: () => Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "down" })) }),
);

it.layer(layerWith(brokenQueue, memory), { timeout: 30_000 })("SyncRequests with a failing queue", (it) => {
  it.effect("reports the request failed instead of queued", () =>
    Effect.gen(function* () {
      yield* reset;
      expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
      expect(yield* status("octocat")).toEqual({ state: "failed", requestedAt: at(start), syncedAt: null, ...octocat });
    }),
  );

  it.effect("settles a waiting request failed without a start, so it never holds the login past its cooldown", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* fill(300);
      expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
      expect(yield* row("octocat")).toEqual(
        Option.some({
          login: "octocat",
          requestedAt: at(start),
          outcome: "failed",
          startsAt: null,
        }),
      );
      expect(yield* status("octocat")).toMatchObject({ state: "failed" });
    }),
  );
});
