import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as Memory from "@stargrep/db/memory";
import * as Fake from "@stargrep/github/github.fixture";
import type { GitHubAccountId, Login, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as EnrichQueue from "./enrich-queue.ts";
import * as StarSync from "./star-sync.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const minute = 60_000;
const syncTime = Date.parse("2026-11-04T00:00:00Z");

interface Starred {
  readonly repo: number;
  readonly at: number;
}

type BeforePage = (page: number, list: Array<Starred>) => Fake.Reply | undefined;

class Sql extends Context.Service<Sql, Memory.Pglite["client"]>()("@stargrep/core/stars/star-sync.test/Sql") {}

const lists = new Map<string, Array<Starred>>();
const sent: Array<RepoId> = [];
const hooks: { beforePage: BeforePage } = { beforePage: () => undefined };

const github = Fake.layer((request) => {
  const login = decodeURIComponent(request.url.pathname.split("/")[2] ?? "");
  const page = Number(request.url.searchParams.get("page"));
  const list = lists.get(login) ?? [];
  const failure = hooks.beforePage(page, list);
  if (failure !== undefined) return failure;
  return {
    body: list.slice((page - 1) * 100, page * 100).map((star) => ({
      starred_at: DateTime.formatIso(DateTime.makeUnsafe(star.at)),
      repo: { id: star.repo, node_id: `R_${star.repo}`, name: `repo-${star.repo}`, owner: { login: "owner" } },
    })),
    headers: {
      ...Fake.rateLimitHeaders(4000),
      ...(page * 100 < list.length
        ? { link: `<https://api.github.com/user/1/starred?per_page=100&page=${page + 1}>; rel="next"` }
        : {}),
    },
  };
});

const layerTest = Layer.unwrap(
  Effect.map(Memory.open, (pglite) =>
    StarSync.layer.pipe(
      Layer.provideMerge(Memory.layerPglite(pglite, { embeddingModel })),
      Layer.provideMerge(github.layer),
      Layer.provideMerge(EnrichQueue.layerMemory(sent)),
      Layer.provideMerge(Layer.succeed(Sql, pglite.client)),
    ),
  ),
);

const query = <A>(text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(Sql, (sql) => Effect.promise(() => sql.query<A>(text, [...values]))).pipe(
    Effect.map((result) => result.rows),
  );

const reset = (beforePage: BeforePage = () => undefined) =>
  Effect.gen(function* () {
    lists.clear();
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

const account = (id: number, login: string, list: Array<Starred>) =>
  Effect.gen(function* () {
    lists.set(login, list);
    yield* (yield* Db.Db).accounts.upsert({
      id: id as GitHubAccountId,
      type: "user",
      login: login as Login,
      name: null,
      avatarUrl: null,
      followers: null,
      publicRepos: null,
      ownedRepoStars: null,
    });
    return id as GitHubAccountId;
  });

const sync = (accountId: GitHubAccountId, mode: StarSync.Mode = "incremental") =>
  Effect.flatMap(StarSync.StarSync, (starSync) => starSync.sync({ accountId, mode }));

const rows = (accountId: GitHubAccountId) =>
  query<{ repo_id: number; starred_at: Date; unstarred_at: Date | null }>(
    "select repo_id::int, starred_at, unstarred_at from stars where account_id = $1 order by repo_id",
    [accountId],
  ).pipe(
    Effect.map((all) =>
      all.map((row) => ({
        repo: row.repo_id,
        starredAt: row.starred_at.getTime(),
        unstarredAt: row.unstarred_at?.getTime() ?? null,
      })),
    ),
  );

const activeRepos = (accountId: GitHubAccountId) =>
  Effect.map(rows(accountId), (all) => all.filter((row) => row.unstarredAt === null).map((row) => row.repo));

const report = (values: Partial<StarSync.SyncReport>) => expect.objectContaining(values);

const byNumber = (a: number, b: number) => a - b;

it.layer(layerTest, { timeout: 30_000 })("StarSync", (test) => {
  test.effect("writes every star on a first sync and enqueues each new repo once", () =>
    Effect.gen(function* () {
      yield* reset();
      const list = newestFirst(250);
      const id = yield* account(1, "ada", list);

      expect(yield* sync(id)).toEqual({ listed: 250, added: 250, unchanged: 0, unstarred: 0, enqueued: 250 });
      expect(yield* activeRepos(id)).toEqual(list.map((star) => star.repo).toSorted(byNumber));
      expect(sent.toSorted(byNumber)).toEqual(list.map((star) => star.repo as RepoId).toSorted(byNumber));
      expect(github.sent).toHaveLength(3);
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
      expect(yield* sync(id)).toEqual({ listed: 0, added: 0, unchanged: 250, unstarred: 0, enqueued: 0 });
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
      expect(yield* sync(id)).toEqual({ listed: 2, added: 2, unchanged: 250, unstarred: 0, enqueued: 2 });
      expect(github.sent.length - requests).toBe(1);
      expect(yield* activeRepos(id)).toContain(900);
      expect(sent.slice(-2)).toEqual([900 as RepoId, 901 as RepoId]);
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
      expect(yield* sync(id, "full")).toEqual({ listed: 149, added: 0, unchanged: 149, unstarred: 1, enqueued: 149 });
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
      expect(yield* sync(id)).toEqual({ listed: 1, added: 1, unchanged: 149, unstarred: 0, enqueued: 1 });
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
      expect(new Set(sent).size).toBe(450);
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
      expect(yield* query<{ count: number }>("select count(*)::int as count from repos")).toEqual([{ count: 180 }]);
    }),
  );

  test.effect("skips a repo the list shows twice when a new star shifts the pages", () =>
    Effect.gen(function* () {
      yield* reset((page, list) => {
        if (page === 2 && list[0]?.repo !== 999) list.unshift({ repo: 999, at: syncTime + 1000 });
        return undefined;
      });
      const id = yield* account(1, "ada", newestFirst(150));
      expect(yield* sync(id)).toEqual(report({ listed: 150, added: 150 }));
      expect(yield* activeRepos(id)).toHaveLength(150);

      yield* TestClock.adjust("1 hour");
      expect(yield* sync(id)).toEqual(report({ listed: 1, added: 1, unchanged: 150 }));
      expect(yield* activeRepos(id)).toContain(999);
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
});
