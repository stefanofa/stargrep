import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import * as Fake from "@stargrep/github/github.fixture";
import type { GitHubAccountId, Login } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as EnrichQueue from "../repos/enrich-queue.ts";
import * as OwnerLookup from "./owner-lookup.ts";
import * as StarSync from "./star-sync.ts";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequests from "./sync-requests.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const second = 1_000;
const minute = 60_000;
const syncTime = Date.parse("2026-11-04T00:00:00Z");

interface Starred {
  readonly repo: number;
  readonly at: number;
}

type BeforePage = (page: number, list: Array<Starred>) => Fake.Reply | undefined;

const lists = new Map<string, Array<Starred>>();
const users = new Map<string, { readonly id: number; readonly login: string }>();
const orgs = new Set<string>();
const queue = EnrichQueue.layerMemory();
const sent = queue.sent;
const hooks: { beforePage: BeforePage } = { beforePage: () => undefined };

const github = Fake.layer((request) => {
  if (request.url.pathname === "/graphql") {
    const login: string = JSON.parse(request.body ?? "{}").variables.login;
    return orgs.has(login)
      ? { body: { data: { user: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a User" }] } }
      : Fake.starCountReply(lists.get(login)?.length ?? 0);
  }
  const [, , login = "", list] = request.url.pathname.split("/");
  if (list === undefined) {
    const user = users.get(login);
    return user === undefined
      ? { status: 404 }
      : { body: { ...user, type: "User", name: null, avatar_url: null, followers: 1, public_repos: 2 } };
  }
  const stars = lists.get(login) ?? [];
  const page = Number(request.url.searchParams.get("page"));
  return (
    hooks.beforePage(page, stars) ??
    Fake.starPage(
      stars.map((star) => ({ repo: star.repo, starredAt: DateTime.formatIso(DateTime.makeUnsafe(star.at)) })),
      request,
    )
  );
});

const layerOn = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
  StarSync.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(github.layer), Layer.provideMerge(queue.layer));

const query = (text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(TestDatabase.TestDatabase, (database) => database.query(text, values));

const reset = (beforePage: BeforePage = () => undefined) =>
  Effect.gen(function* () {
    lists.clear();
    users.clear();
    orgs.clear();
    sent.length = 0;
    github.sent.length = 0;
    hooks.beforePage = beforePage;
    yield* query("truncate github_accounts, repos, stars cascade");
    yield* TestClock.setTime(syncTime);
  });

const newestFirst = (count: number, from = 1): Array<Starred> =>
  Array.from({ length: count }, (_, i) => ({ repo: from + i, at: syncTime - (i + 1) * minute }));

const unstar = (list: Array<Starred>, index: number): Starred => {
  const [gone] = list.splice(index, 1);
  if (gone === undefined) throw new Error(`no star at index ${index}`);
  return gone;
};

const account = (id: number, login: string, list: Array<Starred>, type: "user" | "org" = "user") =>
  Effect.gen(function* () {
    lists.set(login, list);
    if (type === "org") orgs.add(login);
    yield* (yield* Db.Db).accounts.upsert({
      id: id as GitHubAccountId,
      type,
      login: login as Login,
      name: null,
      avatarUrl: null,
      followers: null,
      publicRepos: null,
    });
    return id as GitHubAccountId;
  });

const sync = (accountId: GitHubAccountId, mode: StarSync.Mode = "incremental") =>
  Effect.flatMap(StarSync.StarSync, (starSync) => starSync.sync({ accountId, mode }));

interface Row {
  readonly repo_id: number;
  readonly starred_at: Date;
  readonly unstarred_at: Date | null;
}

const rows = (accountId: GitHubAccountId) =>
  query("select repo_id::int, starred_at, unstarred_at from stars where account_id = $1 order by repo_id", [
    accountId,
  ]).pipe(
    Effect.map((all) =>
      (all as ReadonlyArray<Row>).map((row) => ({
        repo: row.repo_id,
        starredAt: row.starred_at.getTime(),
        unstarredAt: row.unstarred_at?.getTime() ?? null,
      })),
    ),
  );

const activeRepos = (accountId: GitHubAccountId) =>
  Effect.map(rows(accountId), (all) => all.filter((row) => row.unstarredAt === null).map((row) => row.repo));

const starredAt = (accountId: GitHubAccountId, repo: number) =>
  Effect.map(rows(accountId), (all) => all.find((row) => row.repo === repo && row.unstarredAt === null)?.starredAt);

const report = (values: Partial<StarSync.SyncReport>) => expect.objectContaining(values);

const byNumber = (a: number, b: number) => a - b;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const sentRepos = () => sent.map((message) => message.repoId as number);

const starredCount = (accountId: GitHubAccountId) =>
  Effect.map(
    Db.Db.use((db) => db.accounts.require(accountId)),
    (found) => found.starredCount,
  );

const cases = (test: { readonly effect: it.Tester<StarSync.StarSync | Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("stores the starred total whenever a read counts the stars, and an org's as 0", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(3);
      const id = yield* account(11, "counter", list);
      yield* sync(id);
      expect(yield* starredCount(id)).toBe(3);

      yield* TestClock.adjust("2 minutes");
      list.unshift({ repo: 99, at: syncTime + minute });
      yield* sync(id);
      expect(yield* starredCount(id)).toBe(3);
      yield* sync(id, "full");
      expect(yield* starredCount(id)).toBe(4);

      const org = yield* account(12, "an-org", [], "org");
      yield* sync(org);
      expect(yield* starredCount(org)).toBe(0);
    }),
  );

  test.effect("writes every star on a first sync and enqueues each new repo once", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(250);
      const id = yield* account(1, "ada", list);

      expect(yield* sync(id)).toEqual({
        listed: 250,
        added: 250,
        unchanged: 0,
        unstarred: 0,
        enqueued: 250,
        shifted: false,
        requests: 5,
      });
      expect(yield* activeRepos(id)).toEqual(list.map((star) => star.repo).toSorted(byNumber));
      expect(sentRepos().toSorted(byNumber)).toEqual(list.map((star) => star.repo).toSorted(byNumber));
      expect(github.sent.map((sent) => sent.url.pathname)).toEqual([
        "/graphql",
        "/users/ada/starred",
        "/users/ada/starred",
        "/users/ada/starred",
        "/graphql",
      ]);
    }),
  );

  test.effect("enqueues new repos only after it has read the last page", () =>
    Effect.gen(function* () {
      const sentBeforePage: Array<number> = [];
      yield* reset((page) => {
        sentBeforePage.push(sent.length);
        return undefined;
      });
      const id = yield* account(1, "ada", newestFirst(250));
      yield* sync(id);
      expect(sentBeforePage).toEqual([0, 0, 0]);
      expect(new Set(sentRepos()).size).toBe(250);
    }),
  );

  test.effect("makes one request and changes nothing when it runs twice", () =>
    Effect.gen(function* () {
      yield* reset();
      const id = yield* account(1, "ada", newestFirst(250));
      yield* sync(id);
      const before = yield* rows(id);
      const requests = github.sent.length;
      const enqueued = sent.length;

      yield* TestClock.adjust("1 hour");
      expect(yield* sync(id)).toEqual({
        listed: 0,
        added: 0,
        unchanged: 250,
        unstarred: 0,
        enqueued: 0,
        shifted: false,
        requests: 1,
      });
      expect(yield* rows(id)).toEqual(before);
      expect(github.sent.length - requests).toBe(1);
      expect(sent).toHaveLength(enqueued);
    }),
  );

  test.effect("adds only stars newer than the last sync", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(250);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 hour");
      list.unshift({ repo: 900, at: syncTime + 30 * minute }, { repo: 901, at: syncTime + 20 * minute });
      const requests = github.sent.length;
      expect(yield* sync(id)).toEqual({
        listed: 2,
        added: 2,
        unchanged: 250,
        unstarred: 0,
        enqueued: 2,
        shifted: false,
        requests: 1,
      });
      expect(github.sent.length - requests).toBe(1);
      expect(yield* activeRepos(id)).toContain(900);
      expect(sentRepos().slice(-2)).toEqual([900, 901]);
    }),
  );

  test.effect("marks an unstarred repo on a full sync and leaves it alone on an incremental one", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(150);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 hour");
      const gone = unstar(list, 120);
      expect(yield* sync(id)).toEqual(report({ added: 0, unstarred: 0 }));
      expect(yield* activeRepos(id)).toContain(gone.repo);

      yield* TestClock.adjust("1 hour");
      expect(yield* sync(id, "full")).toEqual({
        listed: 149,
        added: 0,
        unchanged: 149,
        unstarred: 1,
        enqueued: 149,
        shifted: false,
        requests: 4,
      });
      const row = (yield* rows(id)).find((candidate) => candidate.repo === gone.repo);
      expect(row?.unstarredAt).toBe(syncTime + 2 * 60 * minute);
      expect(yield* activeRepos(id)).not.toContain(gone.repo);
    }),
  );

  test.effect("clears unstarred_at and moves starred_at when a repo is starred again", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(150);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 hour");
      const gone = unstar(list, 40);
      yield* sync(id, "full");

      yield* TestClock.adjust("1 hour");
      const restarredAt = syncTime + 90 * minute;
      list.unshift({ repo: gone.repo, at: restarredAt });
      expect(yield* sync(id)).toEqual({
        listed: 1,
        added: 1,
        unchanged: 149,
        unstarred: 0,
        enqueued: 1,
        shifted: false,
        requests: 1,
      });
      const row = (yield* rows(id)).find((candidate) => candidate.repo === gone.repo);
      expect(row).toEqual({ repo: gone.repo, starredAt: restarredAt, unstarredAt: null });
    }),
  );

  test.effect("catches a star that was unstarred and starred again between incremental syncs", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(150);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 hour");
      const moved = unstar(list, 10);
      list.unshift({ repo: moved.repo, at: syncTime + 40 * minute }, { repo: 700, at: syncTime + 30 * minute });
      expect(yield* sync(id)).toEqual(report({ added: 2, unchanged: 149 }));
      expect((yield* rows(id)).find((row) => row.repo === moved.repo)?.starredAt).toBe(syncTime + 40 * minute);
      expect(yield* activeRepos(id)).toContain(700);
    }),
  );

  test.effect("resumes a killed first sync and ends with the rows of a clean run", () =>
    Effect.gen(function* () {
      yield* reset();
      const clean = yield* account(1, "ada", newestFirst(450));
      yield* sync(clean);
      const expected = yield* rows(clean);

      const failing = { page: 3 };
      yield* reset((page) => (page === failing.page ? { status: 401 } : undefined));
      const id = yield* account(1, "ada", newestFirst(450));
      expect((yield* Effect.flip(sync(id)))._tag).toBe("Unauthorized");
      expect(yield* activeRepos(id)).toHaveLength(200);

      failing.page = 0;
      expect(yield* sync(id)).toEqual(report({ listed: 450, added: 250, unchanged: 200 }));
      expect(yield* rows(id)).toEqual(expected);
      expect(new Set(sentRepos()).size).toBe(450);
    }),
  );

  test.effect("resumes a killed incremental sync past the stars it already wrote", () =>
    Effect.gen(function* () {
      const failing = { page: 0 };
      yield* reset((page) => (page === failing.page ? { status: 401 } : undefined));
      const list = newestFirst(100, 1000);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 day");
      list.unshift(...newestFirst(150).map((star) => ({ ...star, at: star.at + 12 * 60 * minute })));
      failing.page = 2;
      yield* Effect.flip(sync(id));
      expect(yield* activeRepos(id)).toHaveLength(200);

      failing.page = 0;
      expect(yield* sync(id)).toEqual(report({ added: 50, unchanged: 200 }));
      expect(yield* activeRepos(id)).toHaveLength(250);
    }),
  );

  test.effect("stores a repo two accounts share once", () =>
    Effect.gen(function* () {
      yield* reset();
      const ada = yield* account(1, "ada", newestFirst(120));
      const bob = yield* account(2, "bob", newestFirst(120, 61));
      yield* sync(ada);
      expect(yield* sync(bob)).toEqual(report({ added: 120, enqueued: 120 }));
      expect(yield* query("select count(*)::int as count from repos")).toEqual([{ count: 180 }]);
    }),
  );

  test.effect("does not apply a snapshot when a star added mid-read shifts the pages, then reads it all again", () =>
    Effect.gen(function* () {
      yield* reset((page, list) => {
        if (page === 2 && list[0]?.repo !== 999) list.unshift({ repo: 999, at: syncTime + second });
        return undefined;
      });
      const id = yield* account(1, "ada", newestFirst(150));
      expect(yield* sync(id)).toEqual(report({ listed: 150, added: 150, shifted: true }));
      expect(yield* activeRepos(id)).toHaveLength(150);

      yield* TestClock.adjust("1 hour");
      expect(yield* sync(id)).toEqual(report({ listed: 151, added: 1, unchanged: 150, shifted: false }));
      expect(yield* activeRepos(id)).toContain(999);
    }),
  );

  test.effect(
    "keeps a star a mid-read unstar pushed across a page boundary, and repairs the list on the next run",
    () =>
      Effect.gen(function* () {
        yield* reset((page, list) => {
          if (page === 2 && list[0]?.repo === 1) list.shift();
          return undefined;
        });
        const id = yield* account(1, "ada", newestFirst(230));
        expect(yield* sync(id, "full")).toEqual(report({ listed: 229, unstarred: 0, shifted: true }));
        expect(yield* activeRepos(id)).not.toContain(101);

        yield* TestClock.adjust("1 hour");
        expect(yield* sync(id)).toEqual(report({ added: 1, unstarred: 1, shifted: false }));
        expect(yield* activeRepos(id)).toEqual(range(2, 230));
        yield* TestClock.adjust("1 hour");
        expect(yield* sync(id)).toEqual(report({ added: 0, unstarred: 0 }));
        expect(yield* activeRepos(id)).toEqual(range(2, 230));
      }),
  );

  test.effect("reads past a stored star to a new star that shares its starred_at", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* TestClock.setTime(syncTime + 500);
      const list = [{ repo: 1, at: syncTime }];
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      list.push({ repo: 2, at: syncTime });
      yield* TestClock.adjust("1 second");
      expect(yield* sync(id)).toEqual(report({ added: 1, unchanged: 1 }));
      yield* TestClock.adjust("1 second");
      expect(yield* sync(id)).toEqual(report({ added: 0, unchanged: 2 }));
      expect(yield* activeRepos(id)).toEqual([1, 2]);
    }),
  );

  test.effect("stores a star that became visible after the last full snapshot though starred before it", () =>
    Effect.gen(function* () {
      yield* reset();
      yield* TestClock.setTime(syncTime + 500);
      const list = [{ repo: 1, at: syncTime }];
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      list.unshift({ repo: 2, at: syncTime });
      yield* TestClock.adjust("1 second");
      expect(yield* sync(id)).toEqual(report({ added: 1, unchanged: 1 }));
      yield* TestClock.adjust("1 second");
      expect(yield* sync(id)).toEqual(report({ added: 0, unchanged: 2 }));
      expect(yield* activeRepos(id)).toEqual([1, 2]);
    }),
  );

  test.effect("stores an older starred_at that GitHub lists for a starred repo after the last snapshot", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = [
        { repo: 1, at: syncTime - 10 * second },
        { repo: 2, at: syncTime - 20 * second },
      ];
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      list[0] = { repo: 1, at: syncTime - 15 * second };
      yield* TestClock.adjust("1 minute");
      expect(yield* sync(id)).toEqual(report({ added: 1, unchanged: 1 }));
      expect(yield* starredAt(id, 1)).toBe(syncTime - 15 * second);
      yield* TestClock.adjust("1 minute");
      expect(yield* sync(id)).toEqual(report({ added: 0, unchanged: 2 }));
    }),
  );

  test.effect("reports no added star when the database drops it as older than a newer snapshot", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(5);
      const id = yield* account(1, "ada", list);
      yield* sync(id);

      yield* TestClock.adjust("1 hour");
      list.unshift({ repo: 50, at: syncTime + 30 * minute });
      yield* query("update github_accounts set stars_full_synced_at = $1 where id = $2", [
        DateTime.formatIso(DateTime.makeUnsafe(syncTime + 2 * 60 * minute)),
        id,
      ]);
      expect(yield* sync(id)).toEqual(report({ listed: 1, added: 0, unchanged: 5 }));
      expect(yield* activeRepos(id)).not.toContain(50);
    }),
  );

  test.effect("syncs an org as having no stars without asking GraphQL for a count", () =>
    Effect.gen(function* () {
      yield* reset();
      const id = yield* account(3, "acme", [], "org");
      for (const mode of ["incremental", "full"] as const) {
        expect(yield* sync(id, mode)).toEqual(report({ listed: 0, added: 0, unstarred: 0, shifted: false }));
        yield* TestClock.adjust("1 hour");
      }
      expect(github.sent.map((sent) => sent.url.pathname)).toEqual(["/users/acme/starred", "/users/acme/starred"]);
      const stored = yield* (yield* Db.Db).accounts.require(id);
      expect([stored.starsSyncedAt, stored.starsFullSyncedAt]).not.toContain(null);
    }),
  );

  test.effect("fails with AccountNotFound for an account it has no row for", () =>
    Effect.gen(function* () {
      yield* reset();
      const error = yield* Effect.flip(sync(42 as GitHubAccountId));
      expect(error).toMatchObject({ _tag: "AccountNotFound", accountId: 42 });
      expect(github.sent).toHaveLength(0);
    }),
  );

  test.effect("looks up a login, stores the account, and syncs it", () =>
    Effect.gen(function* () {
      yield* reset();
      users.set("ada", { id: 7, login: "ada" });
      lists.set("ada", newestFirst(120));
      const starSync = yield* StarSync.StarSync;

      expect(yield* starSync.syncLogin({ login: "ada" as Login, mode: "incremental" })).toEqual(
        report({ listed: 120, added: 120, requests: 5 }),
      );
      expect(yield* activeRepos(7 as GitHubAccountId)).toHaveLength(120);
      expect(github.sent.map((sent) => sent.url.pathname)).toEqual([
        "/users/ada",
        "/graphql",
        "/users/ada/starred",
        "/users/ada/starred",
        "/graphql",
      ]);
    }),
  );

  test.effect("keeps rows and owned repo stars under the same account ID after a rename", () =>
    Effect.gen(function* () {
      yield* reset();
      users.set("ada", { id: 7, login: "ada" });
      lists.set("ada", newestFirst(120));
      const starSync = yield* StarSync.StarSync;
      const db = yield* Db.Db;
      yield* starSync.syncLogin({ login: "ada" as Login, mode: "incremental" });
      yield* db.accounts.setOwnedRepoStars({ accountId: 7 as GitHubAccountId, stars: 99 });

      users.delete("ada");
      users.set("lovelace", { id: 7, login: "lovelace" });
      lists.set("lovelace", lists.get("ada") ?? []);
      yield* TestClock.adjust("1 hour");
      expect(yield* starSync.syncLogin({ login: "lovelace" as Login, mode: "incremental" })).toEqual(
        report({ added: 0, unchanged: 120 }),
      );
      expect(yield* db.accounts.require(7 as GitHubAccountId)).toMatchObject({ login: "lovelace", ownedRepoStars: 99 });
      expect(yield* activeRepos(7 as GitHubAccountId)).toHaveLength(120);
    }),
  );
};

it.layer(layerOn(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })("StarSync on PGlite", cases);
it.layer(layerOn(TestDatabase.layerNodePostgres({ embeddingModel })), { timeout: 30_000 })(
  "StarSync on Postgres",
  cases,
);

const owners = OwnerLookup.layerMemory();
const syncs = SyncQueue.layerMemory();

const admission = SyncRequests.layer.pipe(
  Layer.provideMerge(layerOn(TestDatabase.layerMemory({ embeddingModel }))),
  Layer.provideMerge(owners.layer),
  Layer.provideMerge(syncs.layer),
);

const ada = { id: 7 as GitHubAccountId, login: "ada" as Login };
const anyone: SyncRequests.Requester = { _tag: "anyone", caller: Db.CallerKey.make("caller-a") };
const owner: SyncRequests.Requester = { _tag: "owner" };

const begin = Effect.gen(function* () {
  yield* reset();
  yield* query("truncate sync_requests, rate_lines");
  syncs.sent.length = 0;
  owners.owners.clear();
  owners.lookups.length = 0;
  users.set("ada", ada);
});

// GitHub lists these stars for ada, and a lookup reports their count.
const starred = (list: Array<Starred>) => {
  lists.set("ada", list);
  owners.owners.set("ada", {
    account: { ...ada, type: "user", name: null, avatarUrl: null, followers: 1, publicRepos: 2 },
    starredTotal: list.length,
  });
};

const lineUnits = Effect.flatMap(DateTime.now, (now) =>
  Db.Db.use((db) => db.rateLines.wait("all", now, Duration.zero)),
).pipe(Effect.map((wait) => Duration.toMillis(wait) / 1_800));

// Admits ada's sync, then runs and bills the message it queued as the sync-stars consumer does. served counts the
// lookups and the GitHub requests the run made, and paid what the line took for them.
const admitAndRun = (by: SyncRequests.Requester) =>
  Effect.gen(function* () {
    const before = yield* lineUnits;
    const lookups = owners.lookups.length;
    const queued = syncs.sent.length;
    github.sent.length = 0;
    yield* SyncRequests.SyncRequests.use((service) => service.request(ada.login, by));
    const message = syncs.sent[queued];
    if (message === undefined) throw new Error("the request queued no sync");
    const report = yield* StarSync.StarSync.use((service) => service.syncLogin(message));
    yield* SyncRequests.billSync(message.reserved, report.requests);
    return {
      message,
      served: owners.lookups.length - lookups + github.sent.length,
      paid: (yield* lineUnits) - before,
    };
  });

const paidInFull = (run: { readonly served: number; readonly paid: number }) =>
  expect(run.paid).toBeGreaterThanOrEqual(run.served);

const now = Effect.map(DateTime.now, DateTime.toEpochMillis);

it.layer(admission, { timeout: 30_000 })("SyncRequests with StarSync", (it) => {
  it.effect("pays for a first read, its counts included", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(1));
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("pays for an incremental read after 500 new stars", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(1));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      starred([...newestFirst(500, 2).map((star) => ({ ...star, at: star.at + 2 * minute })), ...newestFirst(1)]);
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("pays for an incremental read that crosses a page boundary", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(2));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      starred([...Array.from({ length: 99 }, (_, i) => ({ repo: 3 + i, at: syncTime + minute })), ...newestFirst(2)]);
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("pays for an incremental read after 500 stars were swapped at an unchanged total", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(501));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      starred([
        ...Array.from({ length: 500 }, (_, i) => ({ repo: 502 + i, at: syncTime + minute })),
        ...newestFirst(1),
      ]);
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("pays for an incremental read after unstars the stored count does not show", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(1_000));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      const at = yield* now;
      const fresh = Array.from({ length: 400 }, (_, i) => ({ repo: 5_000 + i, at: at - (i + 1) * minute }));
      starred([...fresh, ...newestFirst(500)]);
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("pays for an incremental read after repos were starred again", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(300));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      const at = yield* now;
      starred(newestFirst(300).map((star, i) => ({ repo: star.repo, at: at - (i + 1) * second })));
      paidInFull(yield* admitAndRun(anyone));
    }),
  );

  it.effect("makes the owner pay for new stars its stored count does not show", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(100));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      const at = yield* now;
      lists.set("ada", [
        ...Array.from({ length: 500 }, (_, i) => ({ repo: 5_000 + i, at: at - (i + 1) * second })),
        ...newestFirst(100),
      ]);
      const run = yield* admitAndRun(owner);
      expect(run.message.mode).toBe("incremental");
      paidInFull(run);
    }),
  );

  it.effect("makes the owner pay for a weekly full read", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(250));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("8 days");
      const run = yield* admitAndRun(owner);
      expect(run.message.mode).toBe("full");
      paidInFull(run);
    }),
  );

  it.effect("pushes the next signed-out start later by what a sync spent past its reservation", () =>
    Effect.gen(function* () {
      yield* begin;
      starred(newestFirst(300));
      yield* admitAndRun(anyone);
      yield* TestClock.adjust("11 minutes");
      const at = yield* now;
      starred(newestFirst(300).map((star, i) => ({ repo: star.repo, at: at - (i + 1) * second })));
      yield* Db.Db.use((db) =>
        db.rateLines.reserve({
          line: "all",
          at: DateTime.makeUnsafe(at),
          cost: Duration.millis(300 * 1_800),
          tolerance: Duration.zero,
          maxWait: Duration.zero,
          force: true,
        }),
      );
      const run = yield* admitAndRun(anyone);
      expect(run.message.reserved).toBe(2);
      expect(run.served).toBe(1 + 1 + 3);

      users.set("grace", { id: 8, login: "grace" });
      owners.owners.set("grace", {
        account: {
          id: 8 as GitHubAccountId,
          login: "grace" as Login,
          type: "user",
          name: null,
          avatarUrl: null,
          followers: 1,
          publicRepos: 2,
        },
        starredTotal: 1,
      });
      const next = yield* SyncRequests.SyncRequests.use((service) =>
        service.request("grace" as Login, { _tag: "anyone", caller: Db.CallerKey.make("caller-b") }),
      );
      const burst = SyncRequests.line.burstUnits;
      expect(next).toMatchObject({
        state: "waiting",
        startsAt: DateTime.makeUnsafe(at + (300 + run.served + SyncRequests.lookupCost - burst) * 1_800),
      });
    }),
  );
});
