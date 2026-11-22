import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import * as Fake from "@stargrep/github/github.fixture";
import { BudgetShare, type GitHubAccountId, type Login } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import * as StarCheck from "./star-check.ts";
import * as SyncQueue from "./sync-queue.ts";

const minute = 60_000;
const hour = 60 * minute;
const now = Date.parse("2026-11-22T12:00:00Z");
const share = BudgetShare.make(0.5);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

// What GitHub reports for a login: the account it names, how many repos it stars, and its newest star's time.
interface Remote {
  readonly id: number;
  readonly total: number;
  readonly newest: number | null;
}

const remote = new Map<string, Remote>();
const replies: { status: number; remaining: number } = { status: 200, remaining: 4000 };

const answer = (request: Fake.Sent): Fake.Reply => {
  const variables: Record<string, string> = JSON.parse(request.body ?? "{}").variables;
  const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
  const errors: Array<unknown> = [];
  for (const [name, login] of Object.entries(variables)) {
    const alias = name.replace(/^l/, "p");
    const found = remote.get(login);
    data[alias] =
      found === undefined
        ? null
        : {
            databaseId: found.id,
            starredRepositories: {
              totalCount: found.total,
              edges: found.newest === null ? [] : [{ starredAt: iso(found.newest) }],
            },
          };
    if (found === undefined) {
      errors.push({
        type: "NOT_FOUND",
        path: [alias],
        message: `Could not resolve to a User with the login of '${login}'.`,
      });
    }
  }
  return {
    status: replies.status,
    body: errors.length === 0 ? { data } : { data, errors },
    headers: Fake.rateLimitHeaders(replies.remaining, now / 1000 + 3600, "graphql"),
  };
};

// Each fixture has a token gate of its own, because a spent budget share stays spent for the gate's life.
const fixture = () => {
  const github = Fake.layer(answer);
  const syncs = SyncQueue.layerMemory();
  const layer = Layer.mergeAll(github.layer, syncs.layer).pipe(
    Layer.provideMerge(TestDatabase.layerMemory({ embeddingModel: "test/model" as EmbeddingModelId })),
  );
  return { github, syncs, layer };
};

const { github, syncs, layer } = fixture();
const spent = fixture();

const query = (text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(TestDatabase.TestDatabase, (database) => database.query(text, values));

const reset = Effect.gen(function* () {
  remote.clear();
  replies.status = 200;
  replies.remaining = 4000;
  for (const each of [syncs.sent, github.sent, spent.syncs.sent, spent.github.sent]) each.length = 0;
  yield* query("truncate github_accounts, rate_lines cascade");
  yield* TestClock.setTime(now);
});

// A synced user Stargrep stored, last synced and checked at these times.
const stored = (
  id: number,
  login: string,
  options: { syncedAt: number; checkedAt?: number; count?: number; type?: "user" | "org" },
) =>
  query(
    `insert into github_accounts (id, type, login, public_repos, starred_count, stars_synced_at, stars_checked_at)
     values ($1, $2, $3, 0, $4, $5, $6)`,
    [
      id,
      options.type ?? "user",
      login,
      options.count ?? null,
      iso(options.syncedAt),
      options.checkedAt === undefined ? null : iso(options.checkedAt),
    ],
  );

const checks = Effect.map(
  query("select id::int, starred_count, stars_checked_at from github_accounts order by id"),
  (rows) =>
    Object.fromEntries(
      (rows as ReadonlyArray<{ id: number; starred_count: number | null; stars_checked_at: Date | null }>).map(
        (row) => [row.id, { count: row.starred_count, checkedAt: row.stars_checked_at?.getTime() ?? null }],
      ),
    ),
);

const run = StarCheck.run(share);

it.layer(layer, { timeout: 30_000 })("StarCheck", (it) => {
  it.effect("marks an account with no newer star checked and syncs nothing", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 3 });
      remote.set("ada", { id: 1, total: 3, newest: now - 3 * hour });

      const report = yield* run;

      expect(report).toMatchObject({ due: 1, current: 1, synced: 0, missing: 0, points: 1, stop: "done" });
      expect(syncs.sent).toEqual([]);
      expect(yield* checks).toEqual({ 1: { count: 3, checkedAt: now } });
    }),
  );

  it.effect("sends an incremental sync with its turn in githubAll for an account with a newer star", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 3 });
      remote.set("ada", { id: 1, total: 4, newest: now - hour });

      const report = yield* run;

      expect(report).toMatchObject({ current: 0, synced: 1, stop: "done" });
      expect(syncs.sent).toEqual([
        expect.objectContaining({ login: "ada", mode: "incremental", reserved: expect.objectContaining({ units: 2 }) }),
      ]);
      expect(syncs.delays).toEqual([Duration.zero]);
      // The stored stars are not current until the sync finishes, so the account stays unchecked.
      expect(yield* checks).toEqual({ 1: { count: 3, checkedAt: null } });
    }),
  );

  it.effect("records a starred total that moved with no newer star, and syncs nothing", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 5 });
      remote.set("ada", { id: 1, total: 4, newest: now - 3 * hour });

      expect(yield* run).toMatchObject({ current: 1, synced: 0 });
      expect(syncs.sent).toEqual([]);
      expect(yield* checks).toEqual({ 1: { count: 4, checkedAt: now } });
    }),
  );

  it.effect("checks people hourly and other synced users daily, the oldest check first", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "person-fresh", { syncedAt: now - 2 * hour, checkedAt: now - 20 * minute });
      yield* stored(2, "person-due", { syncedAt: now - 2 * hour, checkedAt: now - 55 * minute });
      yield* stored(3, "other-fresh", { syncedAt: now - 2 * hour, checkedAt: now - 2 * hour });
      yield* stored(4, "other-due", { syncedAt: now - 2 * hour, checkedAt: now - 24 * hour });
      yield* stored(5, "never", { syncedAt: now - 2 * hour });
      yield* stored(6, "an-org", { syncedAt: now - 2 * hour, type: "org" });
      yield* query(
        "insert into github_accounts (id, type, login, public_repos) values (7, 'user', 'looked-up-only', 0)",
      );
      yield* query(
        `insert into people (account_id, curated, stars, last_starred_at)
         values (1, false, 1, now()), (2, false, 1, now())`,
      );
      for (const [login, id] of [
        ["person-due", 2],
        ["other-due", 4],
        ["never", 5],
      ] as const) {
        remote.set(login, { id, total: 0, newest: null });
      }

      expect(yield* run).toMatchObject({ due: 3, current: 3 });
      const asked = JSON.parse(github.sent[0]?.body ?? "{}").variables;
      expect(asked).toEqual({ l0: "never", l1: "other-due", l2: "person-due" });
    }),
  );

  it.effect("checks the people someone follows hourly, as it checks the people list", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "followed", { syncedAt: now - 2 * hour, checkedAt: now - 2 * hour });
      yield* stored(2, "not-followed", { syncedAt: now - 2 * hour, checkedAt: now - 2 * hour });
      yield* stored(3, "follower", { syncedAt: now - 2 * hour, checkedAt: now - 20 * minute });
      yield* query("insert into follows (follower_id, followee_id, source) values (3, 1, 'stargrep')");
      remote.set("followed", { id: 1, total: 0, newest: null });

      expect(yield* run).toMatchObject({ due: 1, current: 1 });
      expect(JSON.parse(github.sent[0]?.body ?? "{}").variables).toEqual({ l0: "followed" });
    }),
  );

  it.effect("keeps the batch when a login is gone or names another account, and leaves those unchecked", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 3 });
      yield* stored(2, "deleted", { syncedAt: now - 2 * hour, count: 3 });
      yield* stored(3, "renamed-away", { syncedAt: now - 2 * hour, count: 3 });
      remote.set("ada", { id: 1, total: 3, newest: now - 3 * hour });
      remote.set("renamed-away", { id: 99, total: 7, newest: now - minute });

      expect(yield* run).toMatchObject({ due: 3, current: 1, missing: 2, synced: 0, stop: "done" });
      expect(syncs.sent).toEqual([]);
      expect(yield* checks).toEqual({
        1: { count: 3, checkedAt: now },
        2: { count: 3, checkedAt: null },
        3: { count: 3, checkedAt: null },
      });
    }),
  );

  it.effect("defers a sync githubAll cannot start now, and leaves its account unchecked", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 3 });
      remote.set("ada", { id: 1, total: 4, newest: now - hour });
      const all = RateLine.githubAll(share);
      yield* Db.Db.use((db) => RateLine.reserve(db.rateLines, all, DateTime.makeUnsafe(now), all.rate.burst, true));

      expect(yield* run).toMatchObject({ synced: 0, deferred: 1 });
      expect(syncs.sent).toEqual([]);
      expect(yield* checks).toEqual({ 1: { count: 3, checkedAt: null } });
    }),
  );

  it.effect("packs batches by how many stars each account has, so GitHub answers each within its time limit", () =>
    Effect.sync(() => {
      const due = (id: number, starredCount: number | null) => ({
        id: id as GitHubAccountId,
        login: `user-${id}` as Login,
        starredCount,
        starsSyncedAt: DateTime.makeUnsafe(now),
      });
      const sizes = (accounts: ReadonlyArray<ReturnType<typeof due>>) =>
        StarCheck.batches(accounts).map((batch) => batch.length);
      expect(sizes(Array.from({ length: 30 }, (_, id) => due(id + 1, 50)))).toEqual([24, 6]);
      expect(sizes(Array.from({ length: 13 }, (_, id) => due(id + 1, 800)))).toEqual([12, 1]);
      expect(sizes(Array.from({ length: 7 }, (_, id) => due(id + 1, 9_000)))).toEqual([6, 1]);
      expect(sizes([due(1, null), due(2, 50), ...Array.from({ length: 5 }, (_, id) => due(id + 3, 9_000))])).toEqual([
        6, 1,
      ]);
      expect(StarCheck.batches([])).toEqual([]);
    }),
  );

  it.effect("records no check when GitHub fails the probe", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* stored(1, "ada", { syncedAt: now - 2 * hour, count: 3 });
      remote.set("ada", { id: 1, total: 3, newest: now - 3 * hour });
      replies.status = 422;

      expect(yield* run).toMatchObject({ current: 0, stop: "failed" });
      expect(yield* checks).toEqual({ 1: { count: 3, checkedAt: null } });
    }),
  );
});

it.layer(spent.layer, { timeout: 30_000 })("StarCheck on a spent budget", (it) => {
  it.effect("pauses once the token's budget share is spent, and leaves the rest unchecked", () =>
    Effect.gen(function* () {
      yield* reset;
      for (let id = 1; id <= 150; id++) {
        yield* stored(id, `user-${id}`, { syncedAt: now - 2 * hour, count: 1 });
        remote.set(`user-${id}`, { id, total: 1, newest: now - 3 * hour });
      }
      replies.remaining = 0;

      const report = yield* run;

      expect(report).toMatchObject({ due: 150, current: 24, stop: "paused" });
      expect(spent.github.sent.length).toBe(1);
      const checked = Object.values(yield* checks).filter((row) => row.checkedAt !== null);
      expect(checked.length).toBe(24);
    }),
  );
});
