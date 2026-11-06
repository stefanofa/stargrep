import { expect } from "bun:test";
import { type RepoId, RepoNodeId } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { UserId } from "../src/auth-schema.ts";
import * as Db from "../src/db.ts";
import type { Embedding, EmbeddingModelId } from "../src/embedding.ts";
import * as NodePostgres from "../src/node-postgres.ts";
import * as Postgres from "../src/postgres.ts";
import * as TestDatabase from "./database.ts";
import {
  account,
  accountId,
  at,
  embedding,
  facts,
  hybrid,
  iso,
  login,
  model,
  otherModel,
  readme,
  ref,
  repoId,
  repoName,
  starred,
  stars,
} from "./fixtures.ts";

const syncCooldown = Duration.minutes(10);
const summaryOf = (id: RepoId) => `summary of ${id}`;

const embedSummarized = (db: Db.Db["Service"], id: RepoId, vector: Embedding) =>
  db.repos
    .saveSummary({ id, readmeOid: null, summary: summaryOf(id), keywords: [], kind: "app" })
    .pipe(Effect.andThen(db.repos.saveEmbedding({ id, embedding: vector, summary: summaryOf(id), readmeOid: null })));

const sharedCases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("upserts an account and reads the latest facts back", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(101);
      yield* db.accounts.upsert(account(id, { login: login("before") }));
      yield* db.accounts.upsert(account(id, { login: login("after"), type: "org", followers: 7 }));

      const stored = Option.getOrThrow(yield* db.accounts.get(id));
      expect(stored).toMatchObject({ id, type: "org", login: "after", followers: 7, starsEtag: null });
      expect(Option.isNone(yield* db.accounts.get(accountId(999_999)))).toBe(true);
    }),
  );

  test.effect("claims an account for a user and finds it by that user", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [ada, grace] = [UserId.make("user-ada"), UserId.make("user-grace")];
      for (const id of [ada, grace]) {
        yield* database.query("insert into \"user\" (id, name, email) values ($1, $1, $1 || '@example.com')", [id]);
      }
      const id = accountId(110);
      yield* db.accounts.claim({ facts: account(id, { login: login("ada") }), userId: ada, starredCount: 2431 });
      yield* db.accounts.claim({
        facts: account(id, { login: login("ada-renamed") }),
        userId: ada,
        starredCount: 2432,
      });

      expect(Option.getOrThrow(yield* db.accounts.claimedBy(ada))).toMatchObject({
        id,
        login: "ada-renamed",
        claimedBy: ada,
        starredCount: 2432,
      });
      expect(Option.isNone(yield* db.accounts.claimedBy(grace))).toBe(true);
      const second = yield* Effect.flip(
        db.accounts.claim({ facts: account(accountId(112)), userId: ada, starredCount: 1 }),
      );
      expect([second._tag, second.operation]).toEqual(["DbQueryFailed", "accounts.claim"]);
    }),
  );

  test.effect("lists an account's library newest star first, with star totals and without unstarred repos", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(111);
      const [older, newer, gone, untracked] = [repoId(2501), repoId(2502), repoId(2503), repoId(2504)];
      yield* db.accounts.upsert(account(owner));
      yield* db.repos.upsertRefs([older, newer, gone, untracked].map((id) => ref(id)));
      yield* db.repos.saveFacts({ ...facts(newer), description: "Newest star" });
      for (const [id, count] of [
        [older, 10],
        [newer, 1200],
      ] as const) {
        yield* database.query("insert into repo_metrics (repo_id, stars, refreshed_at) values ($1, $2, now())", [
          id,
          count,
        ]);
      }
      const kept = [
        starred(older, "2025-01-01T00:00:00Z"),
        starred(newer, "2026-03-01T00:00:00Z"),
        starred(untracked, "2025-06-01T00:00:00Z"),
      ];
      yield* db.stars.upsert({ accountId: owner, stars: [...kept, starred(gone, "2026-02-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: owner, stars: kept, at: at("2026-04-01T00:00:00Z") });

      const library = yield* db.stars.library(owner);
      expect(library.map((entry) => [entry.repo.id, iso(entry.starredAt), entry.stars])).toEqual([
        [newer, "2026-03-01T00:00:00.000Z", 1200],
        [untracked, "2025-06-01T00:00:00.000Z", null],
        [older, "2025-01-01T00:00:00.000Z", 10],
      ]);
      expect(library[0]?.repo.description).toBe("Newest star");
      expect(yield* db.stars.library(accountId(999_998))).toEqual([]);
    }),
  );

  test.effect("counts an account's read and failed stars, with repos other accounts read first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [reader, other] = [accountId(112), accountId(113)];
      const [shared, own, retrying, failed, unstarred, waiting] = [
        repoId(2511),
        repoId(2512),
        repoId(2513),
        repoId(2514),
        repoId(2515),
        repoId(2516),
      ];
      yield* db.accounts.upsert(account(reader, { login: login("Reader") }));
      yield* db.accounts.upsert(account(other));
      yield* db.repos.upsertRefs([shared, own, retrying, failed, unstarred, waiting].map((id) => ref(id)));
      yield* db.stars.upsert({ accountId: other, stars: [starred(shared, "2025-01-01T00:00:00Z")] });
      yield* embedSummarized(db, shared, embedding({ 0: 1 }));
      expect(yield* db.stars.enrichment(login("reader"))).toEqual({ total: 0, read: 0, failed: 0 });

      const kept = [shared, own, retrying, failed, waiting].map((id) => starred(id, "2025-02-01T00:00:00Z"));
      yield* db.stars.upsert({ accountId: reader, stars: [...kept, starred(unstarred, "2025-02-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: reader, stars: kept, at: at("2026-04-01T00:00:00Z") });
      expect(yield* db.stars.enrichment(login("reader"))).toEqual({ total: 5, read: 1, failed: 0 });

      yield* embedSummarized(db, own, embedding({ 1: 1 }));
      const fail = (ids: ReadonlyArray<RepoId>) =>
        db.repos.recordEnrichFailures({ ids, at: at("2026-05-01T00:00:00Z"), retryDelays: [] });
      yield* fail([retrying, failed, unstarred]);
      yield* fail([failed, unstarred]);
      yield* fail([failed, unstarred, own]);
      expect(yield* db.stars.enrichment(login("READER"))).toEqual({ total: 5, read: 2, failed: 1 });

      const read = new Map((yield* db.stars.library(reader)).map((entry) => [entry.repo.id, entry.read]));
      expect(Object.fromEntries(read)).toEqual({
        [shared]: true,
        [own]: true,
        [retrying]: false,
        [failed]: false,
        [waiting]: false,
      });
      expect(yield* db.stars.enrichment(login("nobody-here"))).toEqual({ total: 0, read: 0, failed: 0 });
    }),
  );

  test.effect("counts a failure once per retry window, only while the repo is pending, and clears it once read", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [pending, read] = [repoId(2521), repoId(2522)];
      yield* db.repos.upsertRefs([ref(pending), ref(read)]);
      yield* embedSummarized(db, read, embedding({ 0: 1 }));
      const retryDelays = [Duration.minutes(10), Duration.hours(1)];
      const fail = (time: string) => db.repos.recordEnrichFailures({ ids: [pending, read], at: at(time), retryDelays });
      const stored = () =>
        database.query(
          "select id::int, enrich_failures, to_char(enrich_retry_at at time zone 'utc', 'HH24:MI:SS') as retry_at from repos where id = any($1) order by id",
          [[pending, read]],
        );
      const states: Array<unknown> = [];
      for (const time of [
        "2026-05-01T12:00:00Z",
        "2026-05-01T12:00:03Z",
        "2026-05-01T12:10:00Z",
        "2026-05-01T12:30:00Z",
        "2026-05-01T13:10:00Z",
        "2026-05-01T13:10:01Z",
      ]) {
        yield* fail(time);
        states.push((yield* stored())[0]);
      }
      expect(states).toEqual([
        { id: pending, enrich_failures: 1, retry_at: "12:10:00" },
        { id: pending, enrich_failures: 1, retry_at: "12:10:00" },
        { id: pending, enrich_failures: 2, retry_at: "13:10:00" },
        { id: pending, enrich_failures: 2, retry_at: "13:10:00" },
        { id: pending, enrich_failures: 3, retry_at: null },
        { id: pending, enrich_failures: 4, retry_at: null },
      ]);
      expect((yield* stored())[1]).toEqual({ id: read, enrich_failures: 0, retry_at: null });
      yield* db.repos.recordEnrichFailures({ ids: [], at: at("2026-05-02T00:00:00Z"), retryDelays });

      yield* embedSummarized(db, pending, embedding({ 1: 1 }));
      expect((yield* stored())[0]).toEqual({ id: pending, enrich_failures: 0, retry_at: null });
    }),
  );

  test.effect(
    "sweeps pending repos under the cap whose retry time passed, earliest first, then never-failed ones",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query("truncate repos cascade");
        const [fresh, due, dueEarlier, waiting, capped, read, freshLater] = [
          repoId(2531),
          repoId(2532),
          repoId(2533),
          repoId(2534),
          repoId(2535),
          repoId(2536),
          repoId(2537),
        ];
        yield* db.repos.upsertRefs([fresh, due, dueEarlier, waiting, capped, read, freshLater].map((id) => ref(id)));
        yield* embedSummarized(db, read, embedding({ 0: 1 }));
        const fail = (ids: ReadonlyArray<RepoId>, time: string) =>
          db.repos.recordEnrichFailures({ ids, at: at(time), retryDelays: [Duration.hours(1), Duration.hours(1)] });
        yield* fail([capped], "2026-05-01T00:00:00Z");
        yield* fail([capped], "2026-05-01T01:00:00Z");
        yield* fail([capped], "2026-05-01T02:00:00Z");
        yield* fail([dueEarlier], "2026-05-01T02:30:00Z");
        yield* fail([due], "2026-05-01T02:45:00Z");
        yield* fail([waiting], "2026-05-01T03:30:00Z");

        const now = at("2026-05-01T04:00:00Z");
        expect(yield* db.repos.sweepable({ now, limit: 10 })).toEqual([dueEarlier, due, fresh, freshLater]);
        expect(yield* db.repos.sweepable({ now, limit: 2 })).toEqual([dueEarlier, due]);
        expect(yield* db.repos.sweepable({ now: at("2026-05-01T05:00:00Z"), limit: 10 })).toEqual([
          dueEarlier,
          due,
          waiting,
          fresh,
          freshLater,
        ]);
      }),
  );

  test.effect("finds an account by login in any case", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(102);
      yield* db.accounts.upsert(account(id, { login: login("Octo-Cat") }));
      expect(Option.getOrThrow(yield* db.accounts.byLogin(login("octo-cat"))).id).toBe(id);
      expect(Option.isNone(yield* db.accounts.byLogin(login("nobody-here")))).toBe(true);
    }),
  );

  test.effect("stores repo refs and follows renames", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [first, second] = [repoId(2001), repoId(2002)];
      yield* db.repos.upsertRefs([ref(first), ref(second)]);
      yield* db.repos.upsertRefs([ref(first, "renamed"), ref(second)]);

      expect(Option.getOrThrow(yield* db.repos.get(first)).name).toBe(repoName("renamed"));
      expect((yield* db.repos.require(second)).name).toBe(repoName(`repo-${second}`));
      expect(yield* Effect.flip(db.repos.require(repoId(2099)))).toMatchObject({ _tag: "RepoNotFound", repoId: 2099 });
    }),
  );

  test.effect("stores the GitHub node ID with a repo ref and follows a new one", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2003);
      yield* db.repos.upsertRefs([ref(id)]);
      expect(Option.getOrThrow(yield* db.repos.get(id)).nodeId).toBe(RepoNodeId.make(`R_${id}`));
      yield* db.repos.upsertRefs([ref(id, `repo-${id}`, "R_moved")]);
      expect(Option.getOrThrow(yield* db.repos.get(id)).nodeId).toBe(RepoNodeId.make("R_moved"));
    }),
  );

  test.effect("lets one of many parallel claims for a login win, and claims again after the cooldown", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (name: string, time: string) =>
        db.syncRequests.claim({
          login: login(name),
          at: at(time),
          cooldown: syncCooldown,
          overtakesWaiting: false,
          outcome: "claimed",
        });
      const first = at("2026-11-04T12:00:00Z");
      const claims = yield* Effect.all(
        Array.from({ length: 8 }, (_, i) => claim(i % 2 === 0 ? "Racer" : "racer", "2026-11-04T12:00:00Z")),
        { concurrency: "unbounded" },
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(yield* db.syncRequests.get(login("RACER"))).toEqual(
        Option.some({ login: "racer", requestedAt: first, outcome: "claimed", startsAt: null }),
      );

      expect(yield* claim("racer", "2026-11-04T12:09:59Z")).toBe(false);
      expect(yield* claim("racer", "2026-11-04T12:10:00Z")).toBe(true);
      yield* db.syncRequests.settle(login("Racer"), at("2026-11-04T12:10:00Z"), "failed");
      expect(yield* db.syncRequests.get(login("racer"))).toEqual(
        Option.some({
          login: "racer",
          requestedAt: at("2026-11-04T12:10:00Z"),
          outcome: "failed",
          startsAt: null,
        }),
      );
      yield* db.syncRequests.settle(login("never-requested"), first, "failed");
      expect(yield* db.syncRequests.get(login("never-requested"))).toEqual(Option.none());
    }),
  );

  test.effect("keeps a fresh claim when the dead letter or the schedule of an older one arrives", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (time: string) =>
        db.syncRequests.claim({
          login: login("stale"),
          at: at(time),
          cooldown: syncCooldown,
          overtakesWaiting: false,
          outcome: "claimed",
        });
      expect(yield* claim("2026-11-04T13:00:00Z")).toBe(true);
      expect(yield* claim("2026-11-04T13:11:00Z")).toBe(true);
      for (const outcome of ["failed", "released"] as const) {
        yield* db.syncRequests.settle(login("stale"), at("2026-11-04T13:00:00Z"), outcome);
        yield* db.syncRequests.schedule(login("stale"), at("2026-11-04T13:00:00Z"), at("2026-11-04T14:00:00Z"));
      }
      expect(yield* db.syncRequests.get(login("stale"))).toEqual(
        Option.some({
          login: "stale",
          requestedAt: at("2026-11-04T13:11:00Z"),
          outcome: "claimed",
          startsAt: null,
        }),
      );
    }),
  );

  test.effect("claims a login missing or releases a claim, so only a released login claims again at once", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (name: string, outcome: "claimed" | "missing") =>
        db.syncRequests.claim({
          login: login(name),
          at: at("2026-11-04T15:00:00Z"),
          cooldown: syncCooldown,
          overtakesWaiting: false,
          outcome,
        });
      yield* claim("Ghost", "missing");
      yield* claim("released", "claimed");
      yield* db.syncRequests.settle(login("Released"), at("2026-11-04T15:00:00Z"), "released");
      expect(Option.map(yield* db.syncRequests.get(login("ghost")), (row) => row.outcome)).toEqual(
        Option.some("missing"),
      );
      expect(yield* db.syncRequests.get(login("released"))).toEqual(Option.none());
      expect(yield* claim("ghost", "claimed")).toBe(false);
      expect(yield* claim("released", "claimed")).toBe(true);
    }),
  );

  test.effect("counts a request's cooldown from when it starts in line", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (time: string) =>
        db.syncRequests.claim({
          login: login("waiter"),
          at: at(time),
          cooldown: syncCooldown,
          overtakesWaiting: false,
          outcome: "claimed",
        });
      expect(yield* claim("2026-11-04T16:00:00Z")).toBe(true);
      yield* db.syncRequests.schedule(login("Waiter"), at("2026-11-04T16:00:00Z"), at("2026-11-04T16:30:00Z"));
      expect(yield* db.syncRequests.get(login("waiter"))).toEqual(
        Option.some({
          login: "waiter",
          requestedAt: at("2026-11-04T16:00:00Z"),
          outcome: "pending",
          startsAt: at("2026-11-04T16:30:00Z"),
        }),
      );
      expect(yield* claim("2026-11-04T16:20:00Z")).toBe(false);
      expect(yield* claim("2026-11-04T16:39:59Z")).toBe(false);
      expect(yield* claim("2026-11-04T16:40:00Z")).toBe(true);
      expect(Option.map(yield* db.syncRequests.get(login("waiter")), (row) => row.startsAt)).toEqual(Option.some(null));
    }),
  );

  test.effect("lets a claim that overtakes win over a request still waiting in line, and over nothing else", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (time: string, overtakesWaiting: boolean) =>
        db.syncRequests.claim({
          login: login("overtaken"),
          at: at(time),
          cooldown: syncCooldown,
          overtakesWaiting,
          outcome: "claimed",
        });
      expect(yield* claim("2026-11-04T19:00:00Z", false)).toBe(true);
      expect(yield* claim("2026-11-04T19:01:00Z", true)).toBe(false);
      yield* db.syncRequests.schedule(login("overtaken"), at("2026-11-04T19:00:00Z"), at("2026-11-04T19:30:00Z"));
      expect(yield* claim("2026-11-04T19:05:00Z", false)).toBe(false);
      expect(yield* claim("2026-11-04T19:05:00Z", true)).toBe(true);
      expect(yield* db.syncRequests.get(login("overtaken"))).toEqual(
        Option.some({
          login: "overtaken",
          requestedAt: at("2026-11-04T19:05:00Z"),
          outcome: "claimed",
          startsAt: null,
        }),
      );
      expect(yield* claim("2026-11-04T19:06:00Z", true)).toBe(false);

      yield* db.syncRequests.schedule(login("overtaken"), at("2026-11-04T19:05:00Z"), at("2026-11-04T19:10:00Z"));
      expect(yield* claim("2026-11-04T19:12:00Z", true)).toBe(false);
    }),
  );

  test.effect("counts the pending requests that wait in line and start before a given one", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const now = "2026-11-04T18:00:00Z";
      const waiting = (name: string, startsAt: string) =>
        db.syncRequests
          .claim({
            login: login(name),
            at: at(now),
            cooldown: syncCooldown,
            overtakesWaiting: false,
            outcome: "claimed",
          })
          .pipe(Effect.andThen(db.syncRequests.schedule(login(name), at(now), at(startsAt))));
      yield* waiting("line-a", "2026-11-04T18:05:00Z");
      yield* waiting("line-b", "2026-11-04T18:10:00Z");
      yield* waiting("line-c", "2026-11-04T18:20:00Z");
      yield* waiting("line-failed", "2026-11-04T18:06:00Z");
      yield* db.syncRequests.settle(login("line-failed"), at(now), "failed");
      yield* waiting("line-started", "2026-11-04T17:59:00Z");
      expect(yield* db.syncRequests.ahead(at("2026-11-04T18:20:00Z"), at(now))).toBe(2);
      expect(yield* db.syncRequests.ahead(at("2026-11-04T18:05:00Z"), at(now))).toBe(0);
      expect(yield* db.syncRequests.ahead(at("2026-11-04T18:20:00Z"), at("2026-11-04T18:07:00Z"))).toBe(1);
    }),
  );

  test.effect("prunes the requests made before a time and keeps the later ones", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const claim = (name: string, time: string) =>
        db.syncRequests.claim({
          login: login(name),
          at: at(time),
          cooldown: syncCooldown,
          overtakesWaiting: false,
          outcome: "claimed",
        });
      yield* claim("expired", "2026-11-01T08:00:00Z");
      yield* claim("recent", "2026-11-05T07:00:00Z");
      yield* db.syncRequests.prune(at("2026-11-04T08:00:00Z"));
      expect(yield* db.syncRequests.get(login("expired"))).toEqual(Option.none());
      expect(Option.isSome(yield* db.syncRequests.get(login("recent")))).toBe(true);
    }),
  );

  test.effect("requires an account row and keeps owned repo stars out of account facts", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(103);
      expect((yield* Effect.flip(db.accounts.require(id)))._tag).toBe("AccountNotFound");
      expect((yield* Effect.flip(db.accounts.setOwnedRepoStars({ accountId: id, stars: 5 })))._tag).toBe(
        "AccountNotFound",
      );

      yield* db.accounts.upsert(account(id));
      yield* db.accounts.setOwnedRepoStars({ accountId: id, stars: 42 });
      yield* db.accounts.upsert(account(id, { followers: 3 }));
      expect(yield* db.accounts.require(id)).toMatchObject({ id, followers: 3, ownedRepoStars: 42 });
    }),
  );

  test.effect("writes a looked-up starred count with the facts, keeps it when facts come alone, and sets it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(104);
      expect((yield* Effect.flip(db.accounts.setStarredCount({ accountId: id, starredCount: 1 })))._tag).toBe(
        "AccountNotFound",
      );
      yield* db.accounts.upsertLooked({
        account: { ...account(id, { followers: null }), publicRepos: 3 },
        starredTotal: 2431,
      });
      expect(yield* db.accounts.require(id)).toMatchObject({ followers: null, starredCount: 2431 });
      yield* db.accounts.upsert(account(id, { followers: 5 }));
      expect(yield* db.accounts.require(id)).toMatchObject({ followers: 5, starredCount: 2431 });
      yield* db.accounts.setStarredCount({ accountId: id, starredCount: 2440 });
      expect((yield* db.accounts.require(id)).starredCount).toBe(2440);
    }),
  );

  test.effect("reports repos pending enrichment, in the order asked", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [fresh, enriched, alsoFresh, missing] = [repoId(2051), repoId(2052), repoId(2053), repoId(2059)];
      yield* db.repos.upsertRefs([ref(fresh), ref(enriched), ref(alsoFresh)]);
      yield* db.repos.saveSummary({ id: enriched, readmeOid: null, summary: "done", keywords: [], kind: "app" });
      yield* db.repos.saveEmbedding({
        id: enriched,
        embedding: embedding({ 0: 1 }),
        summary: "done",
        readmeOid: null,
      });

      expect(yield* db.repos.pendingEnrichment([alsoFresh, missing, enriched, fresh])).toEqual([alsoFresh, fresh]);
      yield* db.repos.upsertRefs([ref(fresh), ref(enriched), ref(alsoFresh)]);
      expect(yield* db.repos.pendingEnrichment([fresh, enriched, alsoFresh])).toEqual([fresh, alsoFresh]);
    }),
  );

  test.effect("keeps a repo pending when its summary is current but its embedding failed", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2061);
      yield* db.repos.upsertRefs([ref(id)]);
      yield* db.repos.saveSummary({ id, readmeOid: null, summary: "summarized", keywords: [], kind: "app" });
      expect(yield* db.repos.pendingEnrichment([id])).toEqual([id]);

      yield* db.repos.saveEmbedding({
        id,
        embedding: embedding({ 0: 1 }),
        summary: "summarized",
        readmeOid: null,
      });
      expect(yield* db.repos.pendingEnrichment([id])).toEqual([]);
    }),
  );

  test.effect("records an icon check without touching enrichment, and pages repos unchecked or due a refresh", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [found, missing, unchecked, stale, noNode] = [
        repoId(2801),
        repoId(2802),
        repoId(2803),
        repoId(2805),
        repoId(2804),
      ];
      yield* db.repos.upsertRefs([ref(found), ref(missing), ref(unchecked), ref(stale)]);
      yield* db.repos.saveFacts(facts(noNode));
      yield* embedSummarized(db, found, embedding({ 0: 1 }));
      const checkedBefore = at("2020-01-01T00:00:00Z");
      const page = (after: number, keyVersion = "v1") =>
        Effect.map(db.repos.dueIcons({ after, limit: 4, checkedBefore, keyVersion }), (rows) =>
          rows.map((row) => row.id),
        );

      expect(yield* page(2800)).toEqual([found, missing, unchecked, stale]);
      expect(yield* page(found)).toEqual([missing, unchecked, stale]);

      const icon = { key: "v1/git/abc.webp", source: "repo-file", plate: "dark", size: 96 } as const;
      for (const id of [found, stale]) yield* db.repos.saveIcon({ id, icon });
      yield* db.repos.saveIcon({ id: missing, icon: null });
      yield* db.repos.saveIcon({ id: repoId(2899), icon });
      yield* database.query("update repos set icon_checked_at = '2019-06-01' where id = $1", [stale]);

      expect(yield* page(2800)).toEqual([unchecked, stale]);
      expect(yield* page(2800, "v2")).toEqual([found, unchecked, stale]);
      const stored = Option.getOrThrow(yield* db.repos.get(found));
      expect(stored).toMatchObject({ icon, summary: summaryOf(found) });
      expect(stored).not.toHaveProperty("iconKey");
      expect(Option.getOrThrow(yield* db.repos.get(missing))).toMatchObject({ icon: null });
      expect(Option.getOrThrow(yield* db.repos.get(missing)).iconCheckedAt).not.toBeNull();
      expect((yield* db.repos.getMany([found]))[0]).toMatchObject({ icon, pending: false });
      expect(yield* db.repos.pendingEnrichment([found])).toEqual([]);
      const torn = yield* database.query("update repos set icon_size = null where id = $1", [found]).pipe(
        Effect.as("updated"),
        Effect.catchCause(() => Effect.succeed("refused")),
      );
      expect(torn).toBe("refused");
    }),
  );

  test.effect("saves owner facts with the repo facts and in one batch for the backfill", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [org, user] = [repoId(2811), repoId(2812)];
      const { pending } = yield* db.repos.saveFacts({
        ...facts(org),
        ownerType: "org",
        ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
      });
      yield* db.repos.upsertRefs([ref(user)]);
      yield* db.repos.saveOwners([
        { id: user, ownerType: "user", ownerAvatarUrl: "https://avatars.githubusercontent.com/u/2" },
      ]);

      expect(pending).toBe(true);
      expect(Option.getOrThrow(yield* db.repos.get(org))).toMatchObject({
        ownerType: "org",
        ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
      });
      expect(Option.getOrThrow(yield* db.repos.get(user))).toMatchObject({
        ownerType: "user",
        ownerAvatarUrl: "https://avatars.githubusercontent.com/u/2",
      });
    }),
  );

  test.effect("saves star and fork counts and replaces them on the next save", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = repoId(2150);
      yield* db.repos.saveFacts(facts(id));
      yield* db.repos.saveCounts({ id, stars: 1200, forks: 30 });
      yield* db.repos.saveCounts({ id, stars: 1250, forks: 31 });

      expect(yield* database.query("select stars, forks from repo_metrics where repo_id = $1", [id])).toEqual([
        { stars: 1250, forks: 31 },
      ]);
    }),
  );

  test.effect("saves repo facts and reads them back", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2101);
      yield* db.repos.saveFacts({
        ...facts(id),
        description: "A terminal UI kit",
        topics: ["tui", "rust"],
        language: "Rust",
        license: "MIT",
        createdAt: at("2020-01-02T03:04:05Z"),
        archived: true,
        readmeOid: readme("c"),
      });

      const stored = Option.getOrThrow(yield* db.repos.get(id));
      expect(stored).toMatchObject({
        topics: ["tui", "rust"],
        language: "Rust",
        archived: true,
        readmeOid: readme("c"),
        summary: null,
      });
      expect(iso(stored.createdAt)).toBe("2020-01-02T03:04:05.000Z");
      expect(Option.isNone(yield* db.repos.get(repoId(2199)))).toBe(true);
    }),
  );

  test.effect("clears the embedding when a new summary lands", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2201);
      yield* db.repos.upsertRefs([ref(id)]);
      yield* embedSummarized(db, id, embedding({ 0: 1 }));
      expect(Option.getOrThrow(yield* db.repos.get(id)).embeddingModel).toBe(model);

      yield* db.repos.saveSummary({
        id,
        readmeOid: null,
        summary: "Draws dashboards in the terminal",
        keywords: ["tui"],
        kind: "library",
      });
      expect(Option.getOrThrow(yield* db.repos.get(id))).toMatchObject({
        summary: "Draws dashboards in the terminal",
        keywords: ["tui"],
        kind: "library",
        embeddingModel: null,
      });
    }),
  );

  test.effect("refuses an embedding from another model and keeps the row unchanged", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2301);
      yield* db.repos.upsertRefs([ref(id)]);

      const error = yield* db.repos
        .saveEmbedding({ id, embedding: embedding({ 0: 1 }, otherModel), summary: summaryOf(id), readmeOid: null })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EmbeddingModelMismatch", expected: model, received: otherModel });
      expect(Option.getOrThrow(yield* db.repos.get(id)).embeddingModel).toBeNull();
    }),
  );

  test.effect("fails to update a repo that does not exist", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2401);
      const summary = yield* db.repos
        .saveSummary({ id, readmeOid: null, summary: "", keywords: [], kind: "app" })
        .pipe(Effect.flip);
      const vector = yield* db.repos
        .saveEmbedding({ id, embedding: embedding({ 0: 1 }), summary: summaryOf(id), readmeOid: null })
        .pipe(Effect.flip);
      expect([summary._tag, vector._tag]).toEqual(["RepoNotFound", "RepoNotFound"]);
    }),
  );

  test.effect("ranks the account's active stars by vector distance when the text matches nothing", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [owner, other] = [accountId(401), accountId(402)];
      const [same, close, far, unstarred, notMine] = [
        repoId(4001),
        repoId(4002),
        repoId(4003),
        repoId(4004),
        repoId(4005),
      ];
      yield* db.accounts.upsert(account(owner));
      yield* db.accounts.upsert(account(other));
      yield* db.repos.upsertRefs([same, close, far, unstarred, notMine].map((id) => ref(id)));
      for (const [id, weights] of [
        [same, { 0: 1 }],
        [close, { 0: 1, 1: 1 }],
        [far, { 1: 1 }],
        [unstarred, { 0: 1 }],
        [notMine, { 0: 1 }],
      ] as const) {
        yield* embedSummarized(db, id, embedding(weights));
      }
      yield* db.stars.upsert({
        accountId: owner,
        stars: [same, close, far, unstarred].map((id) => starred(id, "2026-01-01T00:00:00Z")),
      });
      yield* db.stars.upsert({ accountId: other, stars: [starred(notMine, "2026-01-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({
        accountId: owner,
        stars: [same, close, far].map((id) => starred(id, "2026-01-01T00:00:00Z")),
        at: at("2026-02-01T00:00:00Z"),
      });

      const query = { scope: stars(owner), text: "", embedding: embedding({ 0: 1 }) };
      const hits = yield* db.search.hybrid(hybrid({ ...query, limit: 10 }));
      expect(hits.map((hit) => [hit.repo.id, hit.textRank, hit.vectorRank])).toEqual([
        [same, null, 1],
        [close, null, 2],
        [far, null, 3],
      ]);
      expect((yield* db.search.hybrid(hybrid({ ...query, limit: 2 }))).map((hit) => hit.repo.id)).toEqual([
        same,
        close,
      ]);

      const refused = yield* db.search
        .hybrid(hybrid({ ...query, embedding: embedding({ 0: 1 }, otherModel), limit: 10 }))
        .pipe(Effect.flip);
      expect(refused._tag).toBe("EmbeddingModelMismatch");
    }),
  );

  test.effect("ranks a repo that matches both the text and the vector first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(501);
      const [textOnly, both, vectorOnly, neither] = [repoId(5001), repoId(5002), repoId(5003), repoId(5004)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([textOnly, both, vectorOnly, neither].map((repo) => ref(repo)));
      for (const [repo, summary, weights] of [
        [textOnly, "terminal dashboard library", { 1: 1 }],
        [both, "terminal dashboard", { 0: 1 }],
        [vectorOnly, "recipe manager", { 0: 1, 1: 0.1 }],
        [neither, "photo editor", { 2: 1 }],
      ] as const) {
        yield* db.repos.saveSummary({ id: repo, readmeOid: null, summary, keywords: [], kind: "app" });
        yield* db.repos.saveEmbedding({ id: repo, embedding: embedding(weights), summary, readmeOid: null });
      }
      yield* db.stars.upsert({
        accountId: id,
        stars: [textOnly, both, vectorOnly, neither].map((repo) => starred(repo, "2026-01-01T00:00:00Z")),
      });

      const hits = yield* db.search.hybrid(
        hybrid({
          scope: stars(id),
          text: "terminal dashboard",
          embedding: embedding({ 0: 1 }),
          limit: 10,
        }),
      );
      expect(hits[0]?.repo.id).toBe(both);
      expect(hits[0]?.textRank).not.toBeNull();
      expect(hits[0]?.vectorRank).toBe(1);
      const byId = new Map(hits.map((hit) => [hit.repo.id, hit]));
      expect(byId.get(vectorOnly)).toMatchObject({ textRank: null, vectorRank: 2 });
      expect(byId.get(textOnly)?.textRank).not.toBeNull();
      expect(hits.map((hit) => hit.score)).toEqual([...hits.map((hit) => hit.score)].sort((a, b) => b - a));
    }),
  );

  test.effect("counts API calls per procedure and day", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const day = at("2026-05-01T10:00:00Z");
      const later = at("2026-05-01T23:00:00Z");
      const nextDay = at("2026-05-02T01:00:00Z");
      yield* db.usage.increment({ key: "key-1", procedure: "search", at: day });
      yield* db.usage.increment({ key: "key-1", procedure: "search", at: later });
      yield* db.usage.increment({ key: "key-1", procedure: "library", at: day });
      yield* db.usage.increment({ key: "key-1", procedure: "search", at: nextDay });

      expect(yield* db.usage.get({ key: "key-1", on: day })).toEqual({ search: 2, library: 1 });
      expect(yield* db.usage.get({ key: "key-1", on: nextDay })).toEqual({ search: 1 });
      expect(yield* db.usage.get({ key: "key-2", on: day })).toEqual({});
    }),
  );

  test.effect("leaves no partial rows when a transaction fails", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const { withTransaction } = yield* Db.Transactions;
      const id = accountId(601);
      const repo = repoId(6001);

      const error = yield* withTransaction(
        Effect.gen(function* () {
          yield* db.accounts.upsert(account(id));
          yield* db.repos.upsertRefs([ref(repo)]);
          yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
          return yield* Effect.fail("abort" as const);
        }),
      ).pipe(Effect.flip);

      expect(error).toBe("abort");
      expect(Option.isNone(yield* db.accounts.get(id))).toBe(true);
      expect(Option.isNone(yield* db.repos.get(repo))).toBe(true);
    }),
  );

  test.effect("commits every write when a transaction succeeds", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const { withTransaction } = yield* Db.Transactions;
      const id = accountId(602);
      const repo = repoId(6002);

      yield* withTransaction(
        Effect.gen(function* () {
          yield* db.accounts.upsert(account(id));
          yield* db.repos.upsertRefs([ref(repo)]);
          yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
        }),
      );

      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([repo]);
    }),
  );

  test.effect("fails with DbRowInvalid naming the column when a jsonb column holds an older shape", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = repoId(7001);
      yield* db.repos.upsertRefs([ref(id)]);
      yield* database.query(`update repos set topics = '"rust,cli"'::jsonb where id = $1`, [id]);

      const error = yield* db.repos.get(id).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DbRowInvalid", operation: "repos.get", column: "topics" });
    }),
  );

  test.effect("leaves rows embedded by another model out of vector ranking", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = accountId(701);
      const [current, stale] = [repoId(7101), repoId(7102)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(current), ref(stale)]);
      yield* embedSummarized(db, current, embedding({ 0: 1, 1: 1 }));
      yield* embedSummarized(db, stale, embedding({ 0: 1 }));
      yield* db.stars.upsert({
        accountId: id,
        stars: [starred(current, "2026-01-01T00:00:00Z"), starred(stale, "2026-01-01T00:00:00Z")],
      });
      yield* database.query(`update repos set embedding_model = 'old/model' where id = $1`, [stale]);

      const hits = yield* db.search.hybrid(
        hybrid({ scope: stars(id), text: "", embedding: embedding({ 0: 1 }), limit: 10 }),
      );
      expect(hits.map((hit) => hit.repo.id)).toEqual([current]);
    }),
  );

  test.effect("keeps the newer summary when a summary of an older README is replayed", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(9001);
      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("b") });
      yield* db.repos.saveSummary({ id, readmeOid: readme("b"), summary: "NEW", keywords: ["new"], kind: "app" });
      yield* db.repos.saveEmbedding({
        id,
        embedding: embedding({ 0: 1 }),
        summary: "NEW",
        readmeOid: readme("b"),
      });
      yield* db.repos.saveSummary({ id, readmeOid: readme("a"), summary: "STALE", keywords: ["old"], kind: "cli" });

      expect(Option.getOrThrow(yield* db.repos.get(id))).toMatchObject({
        summary: "NEW",
        readmeOid: readme("b"),
        summaryReadmeOid: readme("b"),
        keywords: ["new"],
        kind: "app",
        embeddingModel: model,
      });
      expect(yield* db.repos.pendingEnrichment([id])).toEqual([]);

      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("d") });
      yield* db.repos.saveSummary({ id, readmeOid: readme("b"), summary: "LATE", keywords: [], kind: "app" });
      expect(Option.getOrThrow(yield* db.repos.get(id)).summary).toBe("NEW");
      expect(yield* db.repos.pendingEnrichment([id])).toEqual([id]);
    }),
  );

  test.effect("reports whether saveSummary passed its README guard", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(9011);
      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("b") });
      const summary = { id, summary: "NEW", keywords: [], kind: "app" };
      expect(yield* db.repos.saveSummary({ ...summary, readmeOid: readme("a") })).toBe(false);
      expect(yield* db.repos.saveSummary({ ...summary, readmeOid: readme("b") })).toBe(true);
    }),
  );

  test.effect("refuses an embedding whose summary or README moved, and reports it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(9021);
      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("b") });
      yield* db.repos.saveSummary({ id, readmeOid: readme("b"), summary: "NEW", keywords: [], kind: "app" });
      const vector = { id, embedding: embedding({ 0: 1 }) };
      expect(yield* db.repos.saveEmbedding({ ...vector, summary: "OLD", readmeOid: readme("b") })).toBe(false);
      expect(yield* db.repos.saveEmbedding({ ...vector, summary: "NEW", readmeOid: readme("a") })).toBe(false);

      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("c") });
      expect(yield* db.repos.saveEmbedding({ ...vector, summary: "NEW", readmeOid: readme("b") })).toBe(false);
      expect(Option.getOrThrow(yield* db.repos.get(id)).embeddingModel).toBeNull();

      yield* db.repos.saveFacts({ ...facts(id), readmeOid: readme("b") });
      expect(yield* db.repos.saveEmbedding({ ...vector, summary: "NEW", readmeOid: readme("b") })).toBe(true);
      expect(Option.getOrThrow(yield* db.repos.get(id)).embeddingModel).toBe(model);
    }),
  );

  test.effect("reads many repos in one query and flags each one pending by the rule pendingEnrichment uses", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [fresh, done, unembedded, outdated, missing] = [
        repoId(9031),
        repoId(9032),
        repoId(9033),
        repoId(9034),
        repoId(9039),
      ];
      yield* db.repos.upsertRefs([ref(fresh), ref(done), ref(unembedded), ref(outdated)]);
      yield* embedSummarized(db, done, embedding({ 0: 1 }));
      yield* db.repos.saveSummary({ id: unembedded, readmeOid: null, summary: "s", keywords: [], kind: "app" });
      yield* embedSummarized(db, outdated, embedding({ 0: 1 }));
      yield* db.repos.saveFacts({ ...facts(outdated), readmeOid: readme("e") });

      const ids = [fresh, done, unembedded, outdated, missing];
      const rows = yield* db.repos.getMany(ids);
      const pending = new Set<number>(yield* db.repos.pendingEnrichment(ids));
      expect(rows.map((row) => row.id).toSorted()).toEqual([fresh, done, unembedded, outdated]);
      for (const row of rows) expect(row.pending).toBe(pending.has(row.id));
      expect([...pending].toSorted()).toEqual([fresh, unembedded, outdated]);

      const stored = (id: RepoId) => (id === outdated ? { ...facts(id), readmeOid: readme("e") } : facts(id));
      for (const row of rows) expect((yield* db.repos.saveFacts(stored(row.id))).pending).toBe(pending.has(row.id));
    }),
  );

  test.effect("writes no embedding through saveFacts or upsertRefs, whatever extra fields they carry", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [viaFacts, viaRefs] = [repoId(9101), repoId(9102)];
      const foreign = embedding({ 0: 1 }, otherModel);
      const factsWithVector = { ...facts(viaFacts), embedding: [...foreign.vector], embeddingModel: otherModel };
      const refWithVector = { ...ref(viaRefs), embedding: [...foreign.vector], embeddingModel: otherModel };
      yield* db.repos.saveFacts(factsWithVector);
      yield* db.repos.upsertRefs([refWithVector]);
      expect(Option.getOrThrow(yield* db.repos.get(viaFacts)).embeddingModel).toBeNull();
      expect(Option.getOrThrow(yield* db.repos.get(viaRefs)).embeddingModel).toBeNull();

      yield* embedSummarized(db, viaFacts, embedding({ 0: 1 }));
      yield* db.repos.saveFacts(factsWithVector);
      expect(Option.getOrThrow(yield* db.repos.get(viaFacts)).embeddingModel).toBe(model);
    }),
  );

  test.effect("keeps a write committed beside a transaction that fails", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const { withTransaction } = yield* Db.Transactions;
      const [aborted, committed] = [repoId(9401), repoId(9402)];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const failing = yield* Effect.forkChild(
        withTransaction(
          Effect.gen(function* () {
            yield* db.repos.upsertRefs([ref(aborted)]);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* Effect.fail("abort" as const);
          }),
        ).pipe(Effect.exit),
      );
      yield* Deferred.await(started);
      const beside = yield* Effect.forkChild(withTransaction(db.repos.upsertRefs([ref(committed)])));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(failing);
      yield* Fiber.join(beside);

      expect(Option.isNone(yield* db.repos.get(aborted))).toBe(true);
      expect(Option.isSome(yield* db.repos.get(committed))).toBe(true);
    }),
  );

  test.effect("matches either word of a websearch OR query", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9501);
      const repo = repoId(9501);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo, "terminal")]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });

      const hits = yield* db.search.hybrid(
        hybrid({
          scope: stars(id),
          text: "terminal OR dashboard",
          embedding: embedding({ 0: 1 }),
          limit: 10,
        }),
      );
      expect(hits.map((hit) => [hit.repo.id, hit.textRank])).toEqual([[repo, 1]]);
    }),
  );
};

const settingsCases = (test: { readonly effect: it.Tester<TestDatabase.TestDatabase> }) => {
  const stored = Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) =>
    database.query("select model, dimensions from embedding_settings"),
  );
  const withDb = <A, E>(embeddingModel: EmbeddingModelId, use: (db: Db.Db["Service"]) => Effect.Effect<A, E>) =>
    Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) =>
      Effect.flatMap(Effect.service(Db.Db), use).pipe(Effect.provide(database.connect({ embeddingModel }))),
    );

  test.effect("adopts the configured model in a fresh database", () =>
    Effect.gen(function* () {
      expect(yield* stored).toEqual([{ model, dimensions: 1024 }]);
    }),
  );

  test.effect("refuses to start with another model and keeps the stored one", () =>
    Effect.gen(function* () {
      const error = yield* withDb(otherModel, () => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EmbeddingModelConflict",
        stored: model,
        storedDimensions: 1024,
        configured: otherModel,
        configuredDimensions: 1024,
      });
      expect(yield* stored).toEqual([{ model, dimensions: 1024 }]);
    }),
  );

  test.effect("starts again with the stored model and saves its vectors", () =>
    Effect.gen(function* () {
      const id = repoId(9701);
      const saved = yield* withDb(model, (db) =>
        db.repos
          .upsertRefs([ref(id)])
          .pipe(Effect.andThen(embedSummarized(db, id, embedding({ 0: 1 }))), Effect.andThen(db.repos.get(id))),
      );
      expect(Option.getOrThrow(saved).embeddingModel).toBe(model);
    }),
  );

  test.effect("reads embedding_settings once across builds that share an adoption Ref", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const adopted = yield* Ref.make(false);
      const { tracer, spans } = collectSpans();
      const build = Effect.service(Db.Db).pipe(
        Effect.provide(database.connect({ embeddingModel: model, adopted })),
        Effect.withTracer(tracer),
      );
      const settingsQueries = () => spans.filter((span) => span.name === "Db.settings.adopt").length;
      yield* build;
      const first = settingsQueries();
      yield* build;
      yield* build;
      expect(first).toBeGreaterThan(0);
      expect(settingsQueries()).toBe(first);
      expect(yield* Ref.get(adopted)).toBe(true);
    }),
  );

  test.effect("leaves the adoption Ref unset when the check fails", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const adopted = yield* Ref.make(false);
      const conflict = Effect.service(Db.Db).pipe(
        Effect.provide(database.connect({ embeddingModel: otherModel, adopted })),
        Effect.flip,
      );
      expect((yield* conflict)._tag).toBe("EmbeddingModelConflict");
      expect((yield* conflict)._tag).toBe("EmbeddingModelConflict");
      expect(yield* Ref.get(adopted)).toBe(false);
    }),
  );

  test.effect("changes the stored model only through an explicit migration", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      yield* database.query("update repos set embedding = null, embedding_model = null");
      yield* database.query("update embedding_settings set model = $1", [otherModel]);

      expect((yield* withDb(model, () => Effect.void).pipe(Effect.flip))._tag).toBe("EmbeddingModelConflict");
      const id = repoId(9701);
      const refused = yield* withDb(otherModel, (db) =>
        db.repos
          .saveEmbedding({ id, embedding: embedding({ 0: 1 }, otherModel), summary: summaryOf(id), readmeOid: null })
          .pipe(
            Effect.andThen(
              db.repos
                .saveEmbedding({ id, embedding: embedding({ 0: 1 }), summary: summaryOf(id), readmeOid: null })
                .pipe(Effect.flip),
            ),
          ),
      );
      expect(refused._tag).toBe("EmbeddingModelMismatch");
      expect(yield* stored).toEqual([{ model: otherModel, dimensions: 1024 }]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })(
  "PGlite embedding settings",
  settingsCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres embedding settings",
  settingsCases,
);

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite Db", sharedCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })("node-postgres Db", (test) => {
  sharedCases(test);

  test.effect("sessions opened after the migrations get an 11s statement timeout", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      expect(yield* database.query("select current_setting('statement_timeout') as timeout")).toEqual([
        { timeout: "11s" },
      ]);
    }),
  );

  test.effect("never erases another connection's commit when a transaction fails", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const { withTransaction } = yield* Db.Transactions;
      const [aborted, committed] = [repoId(9601), repoId(9602)];
      const started = yield* Deferred.make<void>();
      const otherCommitted = yield* Deferred.make<void>();
      const failing = yield* Effect.forkChild(
        withTransaction(
          Effect.gen(function* () {
            yield* db.repos.upsertRefs([ref(aborted)]);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(otherCommitted);
            return yield* Effect.fail("abort" as const);
          }),
        ).pipe(Effect.exit),
      );
      yield* Deferred.await(started);
      yield* withTransaction(db.repos.upsertRefs([ref(committed)]));
      yield* Deferred.succeed(otherCommitted, undefined);
      yield* Fiber.join(failing);

      expect(Option.isNone(yield* db.repos.get(aborted))).toBe(true);
      expect(Option.isSome(yield* db.repos.get(committed))).toBe(true);
    }),
  );

  const twoClients = Effect.fn(function* (table: string) {
    const database = yield* TestDatabase.TestDatabase;
    const pool = yield* NodePostgres.acquirePool(Option.getOrThrow(database.url));
    yield* database.query(`create table ${table} (id int primary key, value int)`);
    yield* database.query(`insert into ${table} values (1, 0), (2, 0)`);
    const clients = yield* Effect.acquireRelease(
      Effect.promise(() => Promise.all([pool.connect(), pool.connect()])),
      (held) =>
        Effect.sync(() => {
          for (const client of held) client.release();
        }),
    );
    const { run } = Postgres.make(NodePostgres.driver(pool));
    type Client = (typeof clients)[number];
    const sql = (client: Client, text: string) => Effect.promise(() => client.query(text));
    const attempt = (client: Client, text: string) =>
      run("stars.upsert", () => client.query(text)).pipe(
        Effect.match({ onFailure: Option.some, onSuccess: () => Option.none() }),
        Effect.ensuring(sql(client, "rollback")),
      );
    return { clients, sql, attempt };
  });

  test.effect("fails a statement that deadlocks with another transaction as a conflict", () =>
    Effect.gen(function* () {
      const { clients, sql, attempt } = yield* twoClients("deadlock_probe");
      const [first, second] = clients;
      yield* sql(first, "begin");
      yield* sql(second, "begin");
      yield* sql(first, "update deadlock_probe set value = 1 where id = 1");
      yield* sql(second, "update deadlock_probe set value = 1 where id = 2");
      const failures = yield* Effect.all(
        [
          attempt(first, "update deadlock_probe set value = 2 where id = 2"),
          attempt(second, "update deadlock_probe set value = 2 where id = 1"),
        ],
        { concurrency: 2 },
      );
      expect(failures.flatMap(Option.toArray)).toMatchObject([
        { _tag: "DbQueryFailed", reason: "conflict", sqlState: "40P01" },
      ]);
    }),
  );

  test.effect("fails a serializable statement that loses to a concurrent commit as a conflict", () =>
    Effect.gen(function* () {
      const { clients, sql, attempt } = yield* twoClients("serialization_probe");
      const [first, second] = clients;
      yield* sql(first, "begin isolation level serializable");
      yield* sql(second, "begin isolation level serializable");
      yield* sql(first, "select value from serialization_probe where id = 1");
      yield* sql(second, "select value from serialization_probe where id = 1");
      yield* sql(first, "update serialization_probe set value = 1 where id = 1");
      yield* sql(first, "commit");
      const failure = yield* attempt(second, "update serialization_probe set value = 2 where id = 1");
      expect(Option.getOrNull(failure)).toMatchObject({ _tag: "DbQueryFailed", reason: "conflict", sqlState: "40001" });
    }),
  );

  test.effect("fails a transaction whose connection the server ends as a transport failure", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const { withTransaction } = yield* Db.Transactions;
      const held = "from pg_stat_activity where datname = current_database() and state = 'idle in transaction'";
      const error = yield* withTransaction(
        Effect.gen(function* () {
          yield* db.accounts.get(accountId(9501));
          // With a timeout, pg_terminate_backend returns once the backend has exited.
          expect(yield* database.query(`select pg_terminate_backend(pid, 5000) as terminated ${held}`)).toEqual([
            { terminated: true },
          ]);
          return yield* db.accounts.get(accountId(9501));
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DbQueryFailed", operation: "accounts.get", reason: "transport" });
    }),
  );

  test.effect("returns a pool slot whose connect resolves after the transaction timed out", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const pool = yield* NodePostgres.acquirePool(Option.getOrThrow(database.url));
      const size = pool.options.max;
      const connecting = yield* Deferred.make<void>();
      const nodePostgres = NodePostgres.driver(pool);
      // A leaked client would hold the pool's release open and hide the assertion below, so return
      // any client still out before the pool ends.
      const out = new Set<Postgres.TransactionClient>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const client of out) client.release(true);
        }),
      );
      const { withTransaction } = Postgres.make({
        ...nodePostgres,
        connect: async () => {
          Deferred.doneUnsafe(connecting, Exit.void);
          const client = await nodePostgres.connect();
          const tracked: Postgres.TransactionClient = {
            ...client,
            release: (broken) => {
              out.delete(tracked);
              client.release(broken);
            },
          };
          out.add(tracked);
          return tracked;
        },
      });
      const held = yield* Effect.promise(() => Promise.all(Array.from({ length: size }, () => pool.connect())));

      const transaction = yield* Effect.forkChild(withTransaction(Effect.void).pipe(Effect.flip));
      yield* Deferred.await(connecting);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(transaction)).toMatchObject({
        _tag: "DbQueryFailed",
        operation: "transaction",
        reason: "timeout",
      });
      expect(pool.waitingCount).toBe(1);

      for (const client of held) client.release();
      // The pool hands a released client to the abandoned connect, and its abort handler returns it.
      // Both steps run in callbacks and microtasks, which drain before the next setImmediate.
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      expect({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }).toEqual({
        total: size,
        idle: size,
        waiting: 0,
      });
    }),
  );
});

const password = "p3-test-secret";

it.effect("fails to start on an unreachable Postgres with a transport failure that holds no credential", () =>
  Effect.gen(function* () {
    const unreachable = Db.layerNodePostgres({
      connectionString: Redacted.make(`postgres://stargrep:${password}@127.0.0.1:1/stargrep`),
      embeddingModel: model,
    });
    const error = yield* Effect.service(Db.Db).pipe(Effect.provide(unreachable), Effect.flip);
    expect(error).toMatchObject({ _tag: "DbQueryFailed", operation: "settings.adopt", reason: "transport" });

    const seen = new Set<unknown>();
    const strings: Array<string> = [String(error), error.message, error.stack ?? ""];
    const walk = (value: unknown): void => {
      if (Predicate.isString(value)) strings.push(value);
      if (!Predicate.isObject(value) || seen.has(value)) return;
      seen.add(value);
      for (const key of Reflect.ownKeys(value)) walk(Reflect.get(value, key));
    };
    walk(error);
    expect(strings.filter((text) => text.includes(password))).toEqual([]);
  }),
);
