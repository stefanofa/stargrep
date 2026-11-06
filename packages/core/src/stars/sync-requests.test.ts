import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import type { GitHubAccountId, Login } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequests from "./sync-requests.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const start = Date.parse("2026-11-04T12:00:00Z");
const queue = SyncQueue.layerMemory();

const layerWith = (sender: Layer.Layer<SyncQueue.SyncQueue>) =>
  SyncRequests.layer.pipe(Layer.provideMerge(TestDatabase.layerMemory({ embeddingModel })), Layer.provideMerge(sender));

const at = (millis: number) => DateTime.makeUnsafe(millis);

const reset = Effect.gen(function* () {
  queue.sent.length = 0;
  yield* (yield* TestDatabase.TestDatabase).query("truncate github_accounts, sync_requests cascade");
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

const markFailed = (login: string, requestedAt: number) =>
  Db.Db.use((db) => db.syncRequests.settle(login as Login, at(requestedAt), "failed"));

const request = (login: string, by: SyncRequests.Requester = "anyone") =>
  SyncRequests.SyncRequests.use((service) => service.request(login as Login, by));

const fullSynced = (syncedAt: number) =>
  Db.Db.use((db) => db.stars.applySnapshot({ accountId: 583231 as GitHubAccountId, stars: [], at: at(syncedAt) }));

const modes = () => queue.sent.map((sent) => sent.mode);
const status = (login: string) => SyncRequests.SyncRequests.use((service) => service.status(login as Login));

it.layer(layerWith(queue.layer), { timeout: 30_000 })("SyncRequests", (it) => {
  it.effect("queues an unknown login once and reports it done after a later sync", () =>
    Effect.gen(function* () {
      yield* reset;
      expect(yield* status("octocat")).toEqual({ state: "unknown" });
      expect(yield* request("octocat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
      yield* TestClock.adjust("1 minute");
      expect(yield* request("OctoCat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
      expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "incremental", requestedAt: at(start) }]);

      yield* synced("octocat", start + 30_000);
      expect(yield* status("Octocat")).toEqual({ state: "done", syncedAt: at(start + 30_000) });
    }),
  );

  it.effect("queues one job when the same login is triggered many times at once", () =>
    Effect.gen(function* () {
      yield* reset;
      const answers = yield* Effect.all(
        Array.from({ length: 6 }, () => request("swarm")),
        { concurrency: "unbounded" },
      );
      expect(queue.sent).toHaveLength(1);
      expect(answers.every((answer) => answer.state === "queued")).toBe(true);
    }),
  );

  it.effect("sends again once the cooldown passes and the earlier request never finished", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat");
      yield* TestClock.adjust("11 minutes");
      const later = start + 11 * 60_000;
      expect(yield* request("octocat")).toEqual({ state: "queued", requestedAt: at(later), syncedAt: null });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("answers a login synced inside the cooldown without sending, and syncs it again after", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 5 * 60_000);
      expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 5 * 60_000) });
      expect(queue.sent).toEqual([]);

      yield* TestClock.adjust("6 minutes");
      expect(yield* request("octocat")).toEqual({
        state: "queued",
        requestedAt: at(start + 6 * 60_000),
        syncedAt: at(start - 5 * 60_000),
      });
      expect(queue.sent).toHaveLength(1);
    }),
  );

  it.effect("reports a dead-lettered request as failed and queues it again only after the cooldown", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("no-such-login");
      yield* TestClock.adjust("1 minute");
      yield* markFailed("No-Such-Login", start);
      const failed = { state: "failed", requestedAt: at(start), syncedAt: null } as const;
      expect(yield* status("no-such-login")).toEqual(failed);
      expect(yield* request("no-such-login")).toEqual(failed);
      expect(queue.sent).toHaveLength(1);

      yield* TestClock.adjust("10 minutes");
      expect(yield* request("no-such-login")).toMatchObject({ state: "queued" });
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
      expect(fresh).toMatchObject({ state: "queued", requestedAt: at(start + 11 * 60_000) });
    }),
  );

  it.effect("queues the owner's library open a minute after a sync that anyone has to wait 10 minutes for", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 2 * 60_000);
      yield* fullSynced(start - 2 * 60_000);
      expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 2 * 60_000) });
      expect(yield* request("octocat", "owner")).toEqual({
        state: "queued",
        requestedAt: at(start),
        syncedAt: at(start - 2 * 60_000),
      });
      expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "incremental", requestedAt: at(start) }]);
    }),
  );

  it.effect("bounds the owner to one sync a minute after the last one finished", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 30_000);
      yield* fullSynced(start - 30_000);
      expect(yield* request("octocat", "owner")).toEqual({ state: "done", syncedAt: at(start - 30_000) });
      expect(queue.sent).toEqual([]);

      yield* TestClock.adjust("30 seconds");
      expect(yield* request("octocat", "owner")).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
      yield* TestClock.adjust("70 seconds");
      expect(yield* request("octocat", "owner")).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
      yield* synced("octocat", start + 90_000);
      expect(yield* request("octocat", "owner")).toEqual({ state: "done", syncedAt: at(start + 90_000) });
      expect(queue.sent).toHaveLength(1);

      yield* TestClock.adjust("50 seconds");
      expect(yield* request("octocat", "owner")).toMatchObject({ state: "queued", requestedAt: at(start + 150_000) });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect(
    "makes the owner wait 10 minutes for a first sync still reading, instead of starting a second full read",
    () =>
      Effect.gen(function* () {
        yield* reset;
        expect(yield* request("octocat", "owner")).toMatchObject({ state: "queued", requestedAt: at(start) });
        yield* TestClock.adjust("61 seconds");
        expect(yield* request("octocat", "owner")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
        yield* TestClock.adjust("8 minutes");
        yield* TestClock.adjust("58 seconds");
        yield* request("octocat", "owner");
        expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "full", requestedAt: at(start) }]);

        yield* TestClock.adjust("1 second");
        expect(yield* request("octocat", "owner")).toMatchObject({ state: "queued", requestedAt: at(start + 600_000) });
        expect(queue.sent).toHaveLength(2);
      }),
  );

  it.effect("keeps the 10-minute wait for anyone after the owner's request", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat", "owner");
      yield* TestClock.adjust("9 minutes");
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
      expect(queue.sent).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start + 10 * 60_000) });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect(
    "sends the owner a full sync once the last full read is a week old, and never while a request is queued",
    () =>
      Effect.gen(function* () {
        yield* reset;
        yield* synced("octocat", start - 60 * 60_000);
        yield* fullSynced(start - 6 * 24 * 60 * 60_000);
        yield* request("octocat", "owner");
        expect(modes()).toEqual(["incremental"]);

        yield* synced("octocat", start + 5_000);
        yield* TestClock.adjust("1 day");
        yield* request("octocat", "owner");
        expect(modes()).toEqual(["incremental", "full"]);

        yield* TestClock.adjust("2 minutes");
        yield* request("octocat", "owner");
        expect(modes()).toEqual(["incremental", "full"]);

        yield* TestClock.adjust("8 minutes");
        yield* request("octocat", "owner");
        expect(modes()).toEqual(["incremental", "full", "incremental"]);

        const fullRequest = start + 24 * 60 * 60_000;
        yield* fullSynced(fullRequest + 1_000);
        yield* synced("octocat", fullRequest + 10 * 60_000 + 1_000);
        yield* TestClock.adjust("2 minutes");
        yield* request("octocat", "owner");
        expect(modes()).toEqual(["incremental", "full", "incremental", "incremental"]);
      }),
  );

  it.effect("never sends a full sync for anyone", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* synced("octocat", start - 60 * 60_000);
      yield* request("octocat");
      expect(modes()).toEqual(["incremental"]);
    }),
  );

  it.effect("forgets a request after a day", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* request("octocat");
      yield* TestClock.adjust("25 hours");
      expect(yield* status("octocat")).toEqual({ state: "unknown" });
    }),
  );
});

const brokenQueue = Layer.succeed(
  SyncQueue.SyncQueue,
  SyncQueue.SyncQueue.of({ send: () => Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "down" })) }),
);

it.layer(layerWith(brokenQueue), { timeout: 30_000 })("SyncRequests with a failing queue", (it) => {
  it.effect("reports the request failed instead of queued", () =>
    Effect.gen(function* () {
      yield* reset;
      expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
      expect(yield* status("octocat")).toEqual({ state: "failed", requestedAt: at(start), syncedAt: null });
    }),
  );
});
