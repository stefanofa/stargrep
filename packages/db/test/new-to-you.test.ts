import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, model, otherModel, ref, repoId, starred } from "./fixtures.ts";

interface Seed {
  readonly id: RepoId;
  readonly weights?: Readonly<Record<number, number>>;
  readonly model?: string;
  readonly archived?: boolean;
  readonly gone?: boolean;
}

const vector = (weights: Readonly<Record<number, number>>) =>
  `[${Array.from({ length: 1024 }, (_, index) => weights[index] ?? 0).join(",")}]`;

const seedRepos = Effect.fn("seedRepos")(function* (seeds: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  yield* db.repos.upsertRefs(seeds.map((seed) => ref(seed.id)));
  for (const seed of seeds)
    yield* database.query(
      "update repos set embedding = $1::halfvec, embedding_model = $2, archived = $3, gone_at = $4 where id = $5",
      [
        seed.weights === undefined ? null : vector(seed.weights),
        seed.weights === undefined ? null : (seed.model ?? model),
        seed.archived ?? false,
        seed.gone ? "2026-10-01T00:00:00Z" : null,
        seed.id,
      ],
    );
});

const star = Effect.fn("star")(function* (owner: GitHubAccountId, repos: ReadonlyArray<RepoId>) {
  const db = yield* Db.Db;
  yield* db.accounts.upsert(account(owner));
  yield* db.stars.upsert({
    accountId: owner,
    stars: repos.map((id, index) => starred(id, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`)),
  });
});

const ids = (found: Db.NewToYou) => found.entries.map((entry) => entry.repo.id);

const cases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("ranks a repo close to one of the viewer's interests above one halfway between them", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const viewer = accountId(7001);
      const owner = accountId(7002);
      const rust = [repoId(70_011), repoId(70_012), repoId(70_013)];
      const design = [repoId(70_021), repoId(70_022), repoId(70_023)];
      const nearDesign = repoId(70_031);
      const between = repoId(70_032);
      const elsewhere = repoId(70_033);
      yield* seedRepos([
        ...rust.map((id) => ({ id, weights: { 0: 1 } })),
        ...design.map((id) => ({ id, weights: { 1: 1 } })),
        { id: nearDesign, weights: { 1: 1, 2: 0.1 } },
        { id: between, weights: { 0: 1, 1: 1 } },
        { id: elsewhere, weights: { 3: 1 } },
      ]);
      yield* star(viewer, [...rust, ...design]);
      yield* star(owner, [rust[0] as RepoId, elsewhere, between, nearDesign]);

      const found = yield* db.stars.newToYou({ viewer, owner, limit: 8 });
      expect(found.shared).toBe(1);
      expect(ids(found)).toEqual([nearDesign, between, elsewhere]);
      expect(found.entries[0]?.starredAt).toEqual(
        (yield* db.stars.library(owner)).find((entry) => entry.repo.id === nearDesign)?.starredAt,
      );
    }),
  );

  test.effect("leaves out archived and gone repos and vectors from another model", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const viewer = accountId(7101);
      const owner = accountId(7102);
      const mine = repoId(71_001);
      const kept = repoId(71_002);
      const archived = repoId(71_003);
      const gone = repoId(71_004);
      const otherVector = repoId(71_005);
      const unread = repoId(71_006);
      yield* seedRepos([
        { id: mine, weights: { 0: 1 } },
        { id: kept, weights: { 0: 1 } },
        { id: archived, weights: { 0: 1 }, archived: true },
        { id: gone, weights: { 0: 1 }, gone: true },
        { id: otherVector, weights: { 0: 1 }, model: otherModel },
        { id: unread },
      ]);
      yield* star(viewer, [mine]);
      yield* star(owner, [kept, archived, gone, otherVector, unread]);

      expect(ids(yield* db.stars.newToYou({ viewer, owner, limit: 8 }))).toEqual([kept]);
    }),
  );

  test.effect("counts shared stars and ranks nothing while the viewer's stars have no vectors", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const viewer = accountId(7201);
      const owner = accountId(7202);
      const both = [repoId(72_001), repoId(72_002)];
      const theirs = repoId(72_003);
      yield* seedRepos([...both.map((id) => ({ id })), { id: theirs, weights: { 0: 1 } }]);
      yield* star(viewer, both);
      yield* star(owner, [...both, theirs]);

      expect(yield* db.stars.newToYou({ viewer, owner, limit: 8 })).toEqual({ shared: 2, entries: [] });
    }),
  );

  test.effect("answers at most the limit, closest first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const viewer = accountId(7301);
      const owner = accountId(7302);
      const mine = repoId(73_001);
      const candidates = [1, 2, 3, 4].map((step) => repoId(73_010 + step));
      yield* seedRepos([
        { id: mine, weights: { 0: 1 } },
        ...candidates.map((id, index) => ({ id, weights: { 0: 1, 1: index * 0.5 } })),
      ]);
      yield* star(viewer, [mine]);
      yield* star(owner, candidates.toReversed());

      expect(ids(yield* db.stars.newToYou({ viewer, owner, limit: 2 }))).toEqual(candidates.slice(0, 2));
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite new to you", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres new to you",
  cases,
);
