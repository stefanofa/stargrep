import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import type { KindId } from "@stargrep/knowledge/registry";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import {
  account,
  accountId,
  at,
  facts,
  hybrid,
  login,
  model,
  repoId,
  repoName,
  searchHits,
  starred,
} from "./fixtures.ts";
import { decide, key, newSubjectId, nextRevision } from "./knowledge-fixtures.ts";

const now = at("2026-11-22T00:00:00Z");

// The refresh reads every repo and account, so each test starts from none.
const reset = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query("truncate github_accounts, repos, topics, topic_repos cascade"),
);

interface Seed {
  readonly id: RepoId;
  readonly topics?: ReadonlyArray<string>;
  readonly kinds?: ReadonlyArray<KindId>;
  readonly name?: string;
  readonly archived?: boolean;
}

const seedRepos = Effect.fn("seedRepos")(function* (seeds: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  for (const seed of seeds) {
    yield* db.repos.saveFacts({
      ...facts(seed.id),
      ...(seed.name === undefined ? {} : { name: repoName(seed.name) }),
      topics: [...(seed.topics ?? [])],
      archived: seed.archived ?? false,
    });
    if (seed.kinds !== undefined)
      yield* database.query("update repos set kinds = $2::knowledge_kind[] where id = $1", [seed.id, seed.kinds]);
  }
});

const facets = Effect.fn("facets")(function* (
  id: RepoId,
  roles: { readonly forSubjects?: ReadonlyArray<number>; readonly builtWith?: ReadonlyArray<number> },
) {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(
    `insert into repo_facets (repo_id, for_subjects, built_with, stale) values ($1, $2::bigint[], $3::bigint[], false)
     on conflict (repo_id) do update set for_subjects = excluded.for_subjects, built_with = excluded.built_with`,
    [id, roles.forSubjects ?? [], roles.builtWith ?? []],
  );
});

// Stars the repos as a synced account.
const star = Effect.fn("star")(function* (id: GitHubAccountId, repos: ReadonlyArray<RepoId>) {
  const db = yield* Db.Db;
  yield* db.accounts.upsert(account(id, { login: login(`dev-${id}`), followers: 10 }));
  yield* db.stars.upsert({ accountId: id, stars: repos.map((repo) => starred(repo, "2026-11-01T00:00:00Z")) });
  yield* db.accounts.recordStarSync({ accountId: id, at: at("2026-11-02T00:00:00Z") });
});

// An accepted public subject with its label as its key.
const subjectNamed = Effect.fn("subjectNamed")(function* (label: string) {
  const id = yield* newSubjectId;
  const revision = yield* nextRevision;
  yield* decide("create", {
    created: [{ id, label, definition: null, status: "accepted" }],
    labelsAdded: [{ key: key(label), subjectId: id, isDefault: true, revision }],
  });
  return id;
});

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => repoId(from + index));

const rows = Effect.fn("rows")(function* (id: RepoId) {
  const database = yield* TestDatabase.TestDatabase;
  return yield* database.query(
    "select topic, kinds::text[] as kinds, name_key from repo_topics where repo_id = $1 order by topic",
    [id],
  );
});

const ids = (listed: ReadonlyArray<Db.TopicRepo>) => listed.map(({ repo }): number => repo.id);

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("keeps each repo's topics, kinds, and name as its row changes, and none once archived or gone", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      yield* reset;
      const id = repoId(1);
      yield* seedRepos([{ id, topics: ["cli", "rust"] }]);
      expect(yield* rows(id)).toEqual([
        { topic: "cli", kinds: [], name_key: "repo1" },
        { topic: "rust", kinds: [], name_key: "repo1" },
      ]);

      yield* seedRepos([{ id, topics: ["rust", "tui"], kinds: ["cli"] }]);
      expect(yield* rows(id)).toEqual([
        { topic: "rust", kinds: ["cli"], name_key: "repo1" },
        { topic: "tui", kinds: ["cli"], name_key: "repo1" },
      ]);

      yield* seedRepos([{ id, topics: ["rust", "tui"], archived: true }]);
      expect(yield* rows(id)).toEqual([]);

      yield* seedRepos([{ id, topics: ["rust"] }]);
      yield* database.query("update repos set gone_at = now() where id = $1", [id]);
      expect(yield* rows(id)).toEqual([]);
    }),
  );

  test.effect("gives a topic a page once enough core repos rank, ranked by synced developers", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      const nextjs = yield* subjectNamed("Next.js");
      const core = range(1, 32);
      const facetCore = repoId(40);
      const kindBeatsFacet = repoId(57);
      const untyped = repoId(60);
      const home = repoId(70);
      const archived = repoId(80);
      const gone = repoId(81);
      const built = range(50, 6);
      yield* seedRepos([
        ...core.map((id, index) => ({
          id,
          // Other spellings of nextjs count as nextjs.
          topics: [index === 30 ? "next-js" : index === 31 ? "next" : "nextjs", "react", "hacktoberfest"],
          kinds: ["library" as const],
        })),
        { id: facetCore, kinds: ["library"] },
        ...built.map((id) => ({ id, topics: ["nextjs"], kinds: ["app" as const] })),
        { id: kindBeatsFacet, topics: ["nextjs"], kinds: ["framework"] },
        { id: untyped, topics: ["nextjs"] },
        { id: home, name: "next.js", topics: ["nextjs"], kinds: ["framework"] },
        { id: archived, topics: ["nextjs"], kinds: ["library"], archived: true },
        { id: gone, kinds: ["library"] },
        ...range(90, 3).map((id) => ({ id, topics: ["astro"], kinds: ["library" as const] })),
      ]);
      yield* facets(facetCore, { forSubjects: [nextjs] });
      yield* facets(kindBeatsFacet, { builtWith: [nextjs] });
      // Facets that name the topic bring no archived or gone repo in.
      yield* facets(archived, { forSubjects: [nextjs] });
      yield* facets(gone, { forSubjects: [nextjs] });
      const everyFew = [...core, facetCore, kindBeatsFacet, ...built, home, archived, gone, ...range(90, 3)];
      for (const dev of [1, 2, 3]) yield* star(accountId(dev), everyFew);
      for (const dev of [4, 5]) yield* star(accountId(dev), [...core, home]);
      yield* star(accountId(6), [repoId(2)]);
      yield* (yield* TestDatabase.TestDatabase).query("update repos set gone_at = now() where id = $1", [gone]);
      yield* db.people.refresh(
        [1, 2, 3, 4, 5, 6].map((dev) => login(`dev-${dev}`)),
        now,
      );

      const refreshed = yield* db.topics.refresh();
      const page = Option.getOrThrow(yield* db.topics.page("nextjs"));

      expect(refreshed.listed).toBe(2);
      expect(page.repos).toBe(42);
      expect(page.ranked).toBe(34);
      expect(Option.map(page.home, ({ repo }) => repo.id)).toEqual(Option.some(home));
      expect(ids(page.core)).toEqual([2, 1, ...range(3, 30), facetCore, kindBeatsFacet]);
      expect(page.core.slice(0, 2).map(({ devs }) => devs)).toEqual([6, 5]);
      expect(ids(page.built)).toEqual(built);
      expect(page.related).toEqual([{ topic: "react", repos: 32, ranked: 32 }]);
      expect(page.people.map((person): [string, number, number] => [person.login, person.repos, person.stars])).toEqual(
        [
          ["dev-4", 32, 33],
          ["dev-5", 32, 33],
          ["dev-1", 34, 46],
          ["dev-2", 34, 46],
          ["dev-3", 34, 46],
        ],
      );
      expect(yield* db.topics.page("astro")).toEqual(Option.none());
      expect(yield* db.topics.page("hacktoberfest")).toEqual(Option.none());
      expect(yield* db.topics.size("nextjs")).toEqual(Option.some(42));

      expect(yield* db.topics.resolve("next-js")).toEqual(Option.some("nextjs"));
      expect(yield* db.topics.resolve("NextJS")).toEqual(Option.some("nextjs"));
      expect(yield* db.topics.resolve("astro")).toEqual(Option.none());
      expect(yield* db.topics.pages(["next", "react", "astro", "hacktoberfest"])).toEqual([
        { topic: "next", page: "nextjs" },
        { topic: "react", page: "react" },
      ]);
      expect(yield* db.topics.list({ q: "", offset: 0, limit: 10 })).toEqual({
        topics: [
          { topic: "nextjs", repos: 42, ranked: 34 },
          { topic: "react", repos: 32, ranked: 32 },
        ],
        total: 2,
      });
      expect((yield* db.topics.list({ q: "re", offset: 0, limit: 10 })).topics.map(({ topic }) => topic)).toEqual([
        "react",
      ]);

      // A topic's search reads every repo the topic holds, whatever its role, and no other.
      const hits = yield* searchHits(
        hybrid({ scope: { kind: "topic", topic: "nextjs" }, text: "owner", embedding: null, limit: 50 }),
      );
      const sorted = (found: ReadonlyArray<number>) => found.toSorted((a, b) => a - b);
      expect(sorted(hits.map(({ repo }) => repo.id))).toEqual(
        sorted([...core, facetCore, ...built, kindBeatsFacet, untyped, home]),
      );

      // A topic whose core repos no longer have enough synced developers loses its page.
      yield* (yield* TestDatabase.TestDatabase).query("delete from stars where account_id in (3, 4, 5)");
      expect((yield* db.topics.refresh()).listed).toBe(0);
      expect(yield* db.topics.page("nextjs")).toEqual(Option.none());
    }),
  );

  test.effect("reads a strict topic by its facets alone, and leaves a topic's excluded repos out", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* reset;
      const effect = yield* subjectNamed("Effect");
      // Repos tagged effect for visual effects, of a core kind, and one named effect.
      const visual = range(1, 20);
      // Repos whose facets say they are for Effect, half of them tagged.
      const faceted = range(30, 20);
      const named = repoId(60);
      const astro = range(100, 20);
      const excluded = repoId(530861050);
      yield* seedRepos([
        ...visual.map((id) => ({ id, topics: ["effect"], kinds: ["library" as const] })),
        ...faceted.map((id, index) => ({ id, topics: index % 2 === 0 ? ["effect"] : [], kinds: ["library" as const] })),
        { id: named, name: "effect", topics: ["effect"], kinds: ["framework"] },
        ...range(70, 10).map((id) => ({ id, topics: ["effect"] })),
        ...astro.map((id) => ({ id, topics: ["astro"], kinds: ["library" as const] })),
        ...range(120, 10).map((id) => ({ id, topics: ["astro"] })),
        { id: excluded, topics: ["astro"], kinds: ["library"] },
      ]);
      for (const id of faceted) yield* facets(id, { forSubjects: [effect] });
      for (const dev of [1, 2, 3]) yield* star(accountId(dev), [...visual, ...faceted, named, ...astro, excluded]);
      yield* star(accountId(4), [excluded]);

      expect((yield* db.topics.refresh()).listed).toBe(2);

      const strict = Option.getOrThrow(yield* db.topics.page("effect"));
      expect(ids(strict.core)).toEqual(faceted);
      expect(strict.home).toEqual(Option.none());
      expect([strict.repos, strict.ranked]).toEqual([51, 20]);

      // A topic gets a page at 20 ranked core repos, the excluded one not counted.
      const page = Option.getOrThrow(yield* db.topics.page("astro"));
      expect(ids(page.core)).toEqual(astro);
      expect([page.repos, page.ranked]).toEqual([30, 20]);
      const hits = yield* searchHits(
        hybrid({ scope: { kind: "topic", topic: "astro" }, text: "owner", embedding: null, limit: 50 }),
      );
      expect(hits.map(({ repo }): number => repo.id)).not.toContain(excluded);

      // One fewer ranked core repo, and the topic has no page.
      yield* (yield* TestDatabase.TestDatabase).query("update repos set archived = true where id = $1", [astro[0]]);
      expect((yield* db.topics.refresh()).listed).toBe(1);
      expect(yield* db.topics.page("astro")).toEqual(Option.none());
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 60_000 })("PGlite topics", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 60_000 })("node-postgres topics", cases);
