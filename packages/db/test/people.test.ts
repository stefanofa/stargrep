import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, at, facts, login, model, repoId, starred } from "./fixtures.ts";

const now = at("2026-11-22T00:00:00Z");
const recently = "2026-11-01T00:00:00Z";
const longAgo = "2026-06-01T00:00:00Z";

interface Seed {
  readonly id: RepoId;
  readonly language?: string;
  readonly topics?: ReadonlyArray<string>;
}

// The refresh reads every account, so each test starts from none.
const reset = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query("truncate github_accounts, repos cascade"),
);

const seedRepos = Effect.fn("seedRepos")(function* (seeds: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  for (const seed of seeds)
    yield* db.repos.saveFacts({ ...facts(seed.id), language: seed.language ?? null, topics: [...(seed.topics ?? [])] });
});

interface Person {
  readonly id: GitHubAccountId;
  readonly name?: string;
  readonly followers?: number;
  readonly type?: "user" | "org";
}

// Stars the repos, the newest at starredAt, and records a sync at syncedAt.
const star = Effect.fn("star")(function* (
  person: Person,
  repos: ReadonlyArray<RepoId>,
  starredAt = recently,
  syncedAt = "2026-11-02T00:00:00Z",
) {
  const db = yield* Db.Db;
  yield* db.accounts.upsert(
    account(person.id, {
      login: login(person.name ?? `user-${person.id}`),
      followers: person.followers ?? 6000,
      type: person.type ?? "user",
    }),
  );
  yield* db.stars.upsert({ accountId: person.id, stars: repos.map((id) => starred(id, starredAt)) });
  yield* db.accounts.recordStarSync({ accountId: person.id, at: at(syncedAt) });
});

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => repoId(from + index));

const logins = (page: ReadonlyArray<Db.Person>) => page.map((person): string => person.login);

const counts = (page: ReadonlyArray<Pick<Db.Person, "login" | "shared">>) =>
  page.map((person): readonly [string, number | null] => [person.login, person.shared]);

const everyone = { sort: "recently-active", viewer: Option.none(), offset: 0, limit: 50 } as const;

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("lists the accounts the rule picks and the curated ones, with what each card shows", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      const repos = range(1000, 50);
      yield* seedRepos([
        ...repos.slice(0, 25).map((id) => ({ id, language: "Rust", topics: ["cli", "tui"] })),
        ...repos.slice(25, 35).map((id) => ({ id, language: "Go", topics: ["cli"] })),
        ...repos.slice(35, 40).map((id) => ({ id, language: "C", topics: ["embedded"] })),
        ...repos.slice(40, 45).map((id) => ({ id, language: "Zig" })),
        ...repos.slice(45).map((id) => ({ id })),
      ]);
      yield* star({ id: accountId(1), name: "active" }, repos);
      yield* star({ id: accountId(2), name: "few-followers", followers: 4999 }, repos);
      yield* star({ id: accountId(3), name: "few-stars" }, repos.slice(0, 39));
      yield* star({ id: accountId(4), name: "quiet" }, repos, longAgo);
      yield* star({ id: accountId(5), name: "an-org", type: "org" }, repos);
      yield* star({ id: accountId(6), name: "Curated", followers: 10 }, repos.slice(0, 2), longAgo);

      const refreshed = yield* db.people.refresh([login("curated"), login("never-synced")], now);
      const page = yield* db.people.page(everyone);

      expect(refreshed).toEqual({ listed: 2, recounted: 2 });
      expect(page.total).toBe(2);
      expect(page.people.map(({ lastStarredAt, ...person }) => person)).toEqual([
        {
          accountId: accountId(1),
          login: login("active"),
          avatarUrl: null,
          curated: false,
          stars: 50,
          languages: [
            { language: "Rust", share: 0.5 },
            { language: "Go", share: 0.2 },
            { language: "C", share: 0.1 },
          ],
          topics: ["cli", "tui", "embedded"],
          shared: null,
        },
        {
          accountId: accountId(6),
          login: login("Curated"),
          avatarUrl: null,
          curated: true,
          stars: 2,
          languages: [{ language: "Rust", share: 1 }],
          topics: ["cli", "tui"],
          shared: null,
        },
      ]);
    }),
  );

  test.effect("reads a person's stars again only after a sync, and drops one the rule no longer picks", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      yield* reset;
      const repos = range(2000, 41);
      yield* seedRepos(repos.map((id) => ({ id, language: "Rust" })));
      const stays = { id: accountId(11), name: "stays" };
      const leaves = { id: accountId(12), name: "leaves" };
      yield* star(stays, repos);
      yield* star(leaves, repos.slice(0, 40));
      yield* db.people.refresh([], now);

      expect(yield* db.people.refresh([], now)).toEqual({ listed: 2, recounted: 0 });

      yield* seedRepos([{ id: repoId(2100), language: "Go" }]);
      yield* star(stays, [repoId(2100)], "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
      yield* database.query("update stars set unstarred_at = now() where account_id = $1 and repo_id = $2", [
        leaves.id,
        repos[0],
      ]);

      expect(yield* db.people.refresh([], now)).toEqual({ listed: 1, recounted: 1 });
      const [person] = (yield* db.people.page(everyone)).people;
      expect(person?.login).toBe(login("stays"));
      expect(person?.stars).toBe(42);
      expect(person?.languages).toEqual([
        { language: "Rust", share: 0.976 },
        { language: "Go", share: 0.024 },
      ]);
      const copied = yield* database.query(
        "select account_id::float8 as id, count(*)::int as n from people_stars group by 1",
      );
      expect(copied).toEqual([{ id: stays.id, n: 42 }]);
    }),
  );

  test.effect("pages people by their latest star and counts what a viewer shares with each", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seedRepos(range(3000, 200).map((id) => ({ id })));
      const viewer = { id: accountId(21), name: "viewer" };
      // big shares 30 of 160 stars, small 20 of 40, so small is more like the viewer for its size.
      yield* star({ id: accountId(22), name: "big" }, range(3000, 160), "2026-11-03T00:00:00Z");
      yield* star({ id: accountId(23), name: "small" }, range(3160, 40), "2026-11-02T00:00:00Z");
      yield* star({ id: accountId(24), name: "none" }, range(3000, 40), "2026-11-04T00:00:00Z");
      yield* star(viewer, range(3130, 50), "2026-11-05T00:00:00Z");
      yield* db.people.refresh([], now);

      const recent = yield* db.people.page(everyone);
      const firstTwo = yield* db.people.page({ ...everyone, limit: 2 });
      const rest = yield* db.people.page({ ...everyone, offset: 2, limit: 2 });
      const signedIn = yield* db.people.page({ ...everyone, viewer: Option.some(viewer.id) });
      const likeYou = yield* db.people.page({ ...everyone, sort: "most-like-you", viewer: Option.some(viewer.id) });

      expect(logins(recent.people)).toEqual(["viewer", "none", "big", "small"]);
      expect([logins(firstTwo.people), logins(rest.people), firstTwo.total]).toEqual([
        ["viewer", "none"],
        ["big", "small"],
        4,
      ]);
      expect(signedIn.total).toBe(3);
      expect(counts(signedIn.people)).toEqual([
        ["none", 0],
        ["big", 30],
        ["small", 20],
      ]);
      expect(logins(likeYou.people)).toEqual(["small", "big", "none"]);
      expect(logins((yield* db.people.page({ ...everyone, sort: "most-like-you" })).people)).toEqual(
        logins(recent.people),
      );
    }),
  );

  test.effect("like ranks the people an account shares the most with for their size", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      yield* seedRepos(range(4000, 200).map((id) => ({ id })));
      const subject = { id: accountId(31), name: "subject" };
      yield* star({ id: accountId(32), name: "big" }, range(4000, 160));
      yield* star({ id: accountId(33), name: "small" }, range(4160, 40));
      yield* star({ id: accountId(34), name: "none" }, range(4000, 40));
      yield* star(subject, range(4130, 50));
      yield* db.people.refresh([], now);

      const found = yield* db.people.like(subject.id, 5);

      expect(counts(found)).toEqual([
        ["small", 20],
        ["big", 30],
      ]);
      expect(logins(yield* db.people.like(subject.id, 1))).toEqual(["small"]);
    }),
  );

  test.effect("starredBy names the listed people who star a repo, curated first, then most followed", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      const repos = range(5000, 41);
      yield* seedRepos(repos.map((id) => ({ id })));
      const [shared, other] = [repoId(5000), repoId(5040)];
      yield* star({ id: accountId(41), name: "famous", followers: 90_000 }, repos.slice(0, 40));
      yield* star({ id: accountId(42), name: "known", followers: 20_000 }, repos.slice(0, 40));
      yield* star({ id: accountId(43), name: "chosen", followers: 10 }, [shared]);
      yield* star({ id: accountId(44), name: "owner", followers: 50_000 }, repos.slice(0, 40));
      yield* star({ id: accountId(45), name: "unlisted", followers: 10 }, repos);
      yield* db.people.refresh([login("chosen")], now);

      const found = yield* db.people.starredBy({ repoId: shared, except: accountId(44), limit: 2 });

      expect(found).toEqual({
        people: [
          { login: login("chosen"), avatarUrl: null },
          { login: login("famous"), avatarUrl: null },
        ],
        total: 3,
      });
      expect(yield* db.people.starredBy({ repoId: other, except: accountId(44), limit: 2 })).toEqual({
        people: [],
        total: 0,
      });
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite people", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })("node-postgres people", cases);
