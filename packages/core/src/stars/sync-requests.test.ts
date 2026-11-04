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
import * as SyncRequestLog from "./sync-request-log.ts";
import * as SyncRequests from "./sync-requests.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const start = Date.parse("2026-11-04T12:00:00Z");
const queue = SyncQueue.layerMemory();
const log = SyncRequestLog.layerMemory();

const layerWith = (log: Layer.Layer<SyncRequestLog.SyncRequestLog>) =>
  SyncRequests.layer.pipe(
    Layer.provideMerge(TestDatabase.layerMemory({ embeddingModel })),
    Layer.provideMerge(queue.layer),
    Layer.provideMerge(log),
  );

const at = (millis: number) => DateTime.makeUnsafe(millis);

const reset = Effect.gen(function* () {
  queue.sent.length = 0;
  log.stored.clear();
  yield* (yield* TestDatabase.TestDatabase).query("truncate github_accounts cascade");
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

const markFailed = (login: string) =>
  Effect.flatMap(Effect.service(SyncRequestLog.SyncRequestLog), (service) => service.markFailed(login as Login));

const requests = Effect.service(SyncRequests.SyncRequests);
const request = (login: string) => Effect.flatMap(requests, (service) => service.request(login as Login));
const status = (login: string) => Effect.flatMap(requests, (service) => service.status(login as Login));

it.layer(layerWith(log.layer), { timeout: 30_000 })("SyncRequests", (it) => {
  it.effect("queues an unknown login once and reports it done after a later sync", () =>
    Effect.gen(function* () {
      yield* reset;
      expect(yield* status("octocat")).toEqual({ state: "unknown" });
      expect(yield* request("octocat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
      yield* TestClock.adjust("1 minute");
      expect(yield* request("OctoCat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
      expect(queue.sent).toEqual([{ login: "octocat" as Login, mode: "incremental" }]);

      yield* synced("octocat", start + 30_000);
      expect(yield* status("Octocat")).toEqual({ state: "done", syncedAt: at(start + 30_000) });
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
      yield* markFailed("No-Such-Login");
      const failed = { state: "failed", requestedAt: at(start), syncedAt: null } as const;
      expect(yield* status("no-such-login")).toEqual(failed);
      expect(yield* request("no-such-login")).toEqual(failed);
      expect(queue.sent).toHaveLength(1);

      yield* TestClock.adjust("10 minutes");
      expect(yield* request("no-such-login")).toMatchObject({ state: "queued" });
      expect(queue.sent).toHaveLength(2);
    }),
  );

  it.effect("records a failure for a login that was never requested at the time it failed", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* markFailed("octocat");
      expect(yield* status("octocat")).toEqual({ state: "failed", requestedAt: at(start), syncedAt: null });
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

const down = new SyncRequestLog.SyncRequestLogFailed({ operation: "read", cause: "down" });
const failing = Layer.succeed(
  SyncRequestLog.SyncRequestLog,
  SyncRequestLog.SyncRequestLog.of({
    lastRequest: () => Effect.fail(down),
    markPending: () => Effect.fail(new SyncRequestLog.SyncRequestLogFailed({ operation: "write", cause: "down" })),
    markFailed: () => Effect.fail(down),
  }),
);

it.layer(layerWith(failing), { timeout: 30_000 })("SyncRequests with a failing log", (it) => {
  it.effect("still queues the sync and reads status from the database", () =>
    Effect.gen(function* () {
      yield* reset;
      expect(yield* request("octocat")).toEqual({ state: "queued", requestedAt: at(start), syncedAt: null });
      expect(queue.sent).toHaveLength(1);
      yield* synced("octocat", start + 1_000);
      expect(yield* status("octocat")).toEqual({ state: "done", syncedAt: at(start + 1_000) });
    }),
  );
});
