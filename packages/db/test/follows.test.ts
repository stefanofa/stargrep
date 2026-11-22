import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, at, facts, iso, login, model, repoId, starred } from "./fixtures.ts";

const reset = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query("truncate github_accounts, repos cascade"),
);

interface Seed {
  readonly id: number;
  readonly name: string;
  readonly type?: "user" | "org";
  readonly followers?: number;
  // When the account's stars last synced, or never.
  readonly synced?: string | null;
  readonly stars?: ReadonlyArray<readonly [number, string]>;
}

const seed = Effect.fn("seed")(function* (seeds: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  for (const person of seeds) {
    const id = accountId(person.id);
    yield* db.accounts.upsert(
      account(id, { login: login(person.name), type: person.type ?? "user", followers: person.followers ?? null }),
    );
    for (const [repo] of person.stars ?? []) yield* db.repos.saveFacts(facts(repoId(repo)));
    if (person.stars !== undefined)
      yield* db.stars.upsert({
        accountId: id,
        stars: person.stars.map(([repo, time]) => starred(repoId(repo), time)),
      });
    const synced = person.synced === undefined ? "2026-11-20T00:00:00Z" : person.synced;
    if (synced !== null) yield* db.accounts.recordStarSync({ accountId: id, at: at(synced) });
  }
});

const ada = accountId(1);
const grace = accountId(2);

const follow = (follower: GitHubAccountId, names: ReadonlyArray<string>, cap = 1000) =>
  Effect.flatMap(Db.Db, (db) =>
    db.follows.follow({ follower, logins: names.map((name) => login(name)), source: "stargrep", cap }),
  );

const followed = (follower: GitHubAccountId) =>
  Effect.flatMap(Db.Db, (db) => db.follows.followed(follower)).pipe(Effect.map((rows) => rows.map((row) => row.login)));

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("follows users by login, never the follower or an org, and a repeat adds nothing", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed([
        { id: 1, name: "ada" },
        { id: 2, name: "grace" },
        { id: 3, name: "Linus" },
        { id: 4, name: "vercel", type: "org" },
      ]);
      const first = yield* follow(ada, ["linus", "ada", "vercel", "nobody", "grace"]);
      expect(first).toEqual({ following: [login("Linus"), login("grace")], added: 2, total: 2, full: false });
      const again = yield* follow(ada, ["grace"]);
      expect(again).toEqual({ following: [login("grace")], added: 0, total: 2, full: false });
      // One statement gives both follows the same time, so the account ID orders them.
      expect(yield* followed(ada)).toEqual([login("grace"), login("Linus")]);
    }),
  );

  test.effect("the cap leaves out the logins past it, in the order given", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed([1, 2, 3, 4, 5].map((id) => ({ id, name: `user-${id}` })));
      expect(yield* follow(ada, ["user-2"], 3)).toMatchObject({ added: 1, total: 1, full: false });
      const capped = yield* follow(ada, ["user-5", "user-4", "user-3"], 3);
      expect(capped).toEqual({ following: [login("user-5"), login("user-4")], added: 2, total: 3, full: true });
      expect(yield* follow(ada, ["user-3"], 3)).toEqual({ following: [], added: 0, total: 3, full: true });
    }),
  );

  test.effect("two batches at once never pass the cap", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      yield* reset;
      yield* seed([
        { id: 1, name: "ada" },
        { id: 2, name: "grace" },
        { id: 3, name: "linus" },
      ]);
      yield* database.query(
        "insert into github_accounts (id, type, login) select 1000 + n, 'user', 'filler-' || n from generate_series(1, 999) n",
      );
      yield* database.query(
        "insert into follows (follower_id, followee_id, source) select 1, 1000 + n, 'stargrep' from generate_series(1, 999) n",
      );
      // Holding the follower's row makes each insert wait at its foreign key check, after it has counted, so both
      // batches would count 999 unless the follower's writes take turns.
      const holding = yield* Effect.forkChild(
        database.query(
          "with held as (select id from github_accounts where id = 1 for update) select pg_sleep(0.5) from held",
        ),
      );
      yield* database.query("select pg_sleep(0.1)");
      // Each request builds its own Db, which runs one statement at a time, so the second batch comes from another.
      const elsewhere = follow(ada, ["linus"]).pipe(Effect.provide(database.connect({ embeddingModel: model })));
      const results = yield* Effect.all([follow(ada, ["grace"]), elsewhere], { concurrency: 2 });
      yield* Fiber.join(holding);
      const [count] = yield* database.query("select count(*)::int as n from follows where follower_id = 1");
      expect(count).toEqual({ n: 1000 });
      expect(results.map((result) => result.added).toSorted()).toEqual([0, 1]);
      expect(results.filter((result) => result.full)).toHaveLength(1);
    }),
  );

  test.effect("a login names the account synced most recently, as a renamed login does elsewhere", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed([
        { id: 1, name: "ada" },
        { id: 7, name: "linus", synced: "2026-01-01T00:00:00Z" },
        { id: 8, name: "linus", synced: "2026-11-01T00:00:00Z" },
      ]);
      yield* follow(ada, ["linus"]);
      const [only] = yield* Effect.flatMap(Db.Db, (db) => db.follows.list(ada));
      expect(only?.id).toBe(accountId(8));
    }),
  );

  test.effect("unfollow removes only the follower's own follow", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seed([
        { id: 1, name: "ada" },
        { id: 2, name: "grace" },
        { id: 3, name: "linus" },
      ]);
      yield* follow(ada, ["linus"]);
      yield* follow(grace, ["linus"]);
      expect([
        yield* db.follows.unfollow(ada, login("Linus")),
        yield* db.follows.unfollow(ada, login("linus")),
      ]).toEqual([true, false]);
      expect(yield* followed(ada)).toEqual([]);
      expect(yield* followed(grace)).toEqual([login("linus")]);
    }),
  );

  test.effect("the list gives each followee's latest current star and when their stars were checked", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seed([
        { id: 1, name: "ada" },
        {
          id: 3,
          name: "linus",
          synced: "2026-11-21T00:00:00Z",
          stars: [
            [10, "2026-11-01T00:00:00Z"],
            [11, "2026-11-19T00:00:00Z"],
          ],
        },
        { id: 4, name: "new", synced: null },
      ]);
      // One statement gives both follows the same time, so the account ID orders them.
      yield* follow(ada, ["linus", "new"]);
      // The star check found linus's stars current after the last sync.
      yield* (yield* TestDatabase.TestDatabase).query(
        "update github_accounts set stars_checked_at = '2026-11-22T06:00:00Z' where id = 3",
      );
      const list = yield* db.follows.list(ada);
      expect(
        list.map((person) => ({
          login: person.login,
          synced: iso(person.starsSyncedAt),
          checked: iso(person.checkedAt),
          last: iso(person.lastStarredAt),
          source: person.source,
        })),
      ).toEqual([
        {
          login: login("linus"),
          synced: "2026-11-21T00:00:00.000Z",
          checked: "2026-11-22T06:00:00.000Z",
          last: "2026-11-19T00:00:00.000Z",
          source: "stargrep",
        },
        { login: login("new"), synced: null, checked: null, last: null, source: "stargrep" },
      ]);
    }),
  );

  test.effect("feed stars read each followee's newest stars in the window and say which the follower has", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seed([
        { id: 1, name: "ada", stars: [[20, "2026-10-01T00:00:00Z"]] },
        {
          id: 3,
          name: "linus",
          stars: [
            [20, "2026-11-18T00:00:00Z"],
            [21, "2026-11-19T00:00:00Z"],
            [22, "2026-11-20T00:00:00Z"],
            [23, "2026-09-01T00:00:00Z"],
          ],
        },
        { id: 5, name: "stranger", stars: [[24, "2026-11-20T00:00:00Z"]] },
      ]);
      yield* follow(ada, ["linus"]);
      const found = yield* db.follows.stars({ follower: ada, since: at("2026-10-23T00:00:00Z"), perFollowee: 2 });
      expect(
        found
          .map((star) => ({ repo: star.repoId, at: DateTime.formatIso(star.starredAt), mine: star.mine }))
          .toSorted((a, b) => a.repo - b.repo),
      ).toEqual([
        { repo: repoId(21), at: "2026-11-19T00:00:00.000Z", mine: false },
        { repo: repoId(22), at: "2026-11-20T00:00:00.000Z", mine: false },
      ]);
      const wider = yield* db.follows.stars({ follower: ada, since: at("2026-10-23T00:00:00Z"), perFollowee: 10 });
      expect(wider.find((star) => star.repoId === repoId(20))?.mine).toBe(true);
      expect(wider.every((star) => star.followee === accountId(3))).toBe(true);
    }),
  );

  test.effect("feed repos leave out repos GitHub no longer serves", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      for (const id of [30, 31]) yield* db.repos.saveFacts(facts(repoId(id)));
      yield* (yield* TestDatabase.TestDatabase).query("update repos set gone_at = now() where id = 31");
      const found = yield* db.follows.repos([repoId(30), repoId(31)]);
      expect(found.map((row) => row.repo.id)).toEqual([repoId(30)]);
      expect(yield* db.follows.repos([])).toEqual([]);
    }),
  );

  test.effect(
    "followed starrers are the follower's own followees who star the repo now, the page's login left out",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* reset;
        yield* seed([
          { id: 1, name: "ada" },
          { id: 2, name: "grace" },
          { id: 3, name: "linus", stars: [[40, "2026-11-01T00:00:00Z"]] },
          { id: 4, name: "guido", stars: [[40, "2026-11-10T00:00:00Z"]] },
          { id: 5, name: "rich", stars: [[40, "2026-11-11T00:00:00Z"]] },
        ]);
        yield* follow(ada, ["linus", "guido"]);
        yield* follow(grace, ["rich"]);
        const query = { follower: ada, repoId: repoId(40) as RepoId, limit: 6 };
        expect(yield* db.follows.starredBy({ ...query, except: grace })).toEqual({
          people: [
            { login: login("guido"), avatarUrl: null },
            { login: login("linus"), avatarUrl: null },
          ],
          total: 2,
        });
        expect(yield* db.follows.starredBy({ ...query, except: accountId(4), limit: 1 })).toEqual({
          people: [{ login: login("linus"), avatarUrl: null }],
          total: 1,
        });
      }),
  );

  test.effect("known keeps users with synced stars, the most followed first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seed([
        { id: 3, name: "linus", followers: 10 },
        { id: 4, name: "guido", followers: 500 },
        { id: 5, name: "vercel", type: "org" },
        { id: 6, name: "unsynced", synced: null },
      ]);
      const found = yield* db.follows.known([3, 4, 5, 6, 99].map((id) => accountId(id)));
      expect(found.map((person) => person.login)).toEqual([login("guido"), login("linus")]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite follows", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres follows",
  cases,
);
