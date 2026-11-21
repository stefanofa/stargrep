import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import { repos, similarCandidate } from "../src/schema.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, embedding, facts, model, ref, repoId, starred } from "./fixtures.ts";
import { summarize } from "./summaries.ts";

interface Seed {
  readonly id: RepoId;
  // Each test's repos lie along their own axis, so vectors from different tests sit a distance of 1 apart.
  readonly axis: number;
  // How far along a second axis the repo's vector leans, so a smaller lean sits nearer the repo at 0.
  readonly lean: number;
  readonly summary?: boolean;
  readonly archived?: boolean;
}

// The vector of a repo that leans this far from its axis toward the next one.
const leaning = (axis: number, lean: number) => embedding({ [axis]: 1, [axis + 1]: lean });

const seed = Effect.fn("seed")(function* (repos: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  yield* db.repos.upsertRefs(repos.map((repo) => ref(repo.id)));
  for (const repo of repos) {
    yield* db.repos.saveFacts({ ...facts(repo.id), archived: repo.archived ?? false });
    if (repo.summary === false) {
      // A repo that waits for its summary has an embedding of its metadata.
      yield* database.query(
        "update repos set embedding = $1::halfvec, embedding_model = $2, embedding_source = 'metadata' where id = $3",
        [`[${leaning(repo.axis, repo.lean).vector.join(",")}]`, model, repo.id],
      );
      continue;
    }
    yield* summarize({ id: repo.id, readmeOid: null, summary: `repo ${repo.id}`, keywords: [] });
    yield* db.repos.saveEmbedding({
      ...ref(repo.id),
      keywords: [],
      description: null,
      embedding: leaning(repo.axis, repo.lean),
      summary: `repo ${repo.id}`,
      readmeOid: null,
    });
  }
});

const star = Effect.fn("star")(function* (owner: GitHubAccountId, ids: ReadonlyArray<RepoId>) {
  const db = yield* Db.Db;
  yield* db.accounts.upsert(account(owner));
  yield* db.stars.upsert({ accountId: owner, stars: ids.map((id) => starred(id, "2026-01-01T00:00:00Z")) });
});

const ids = (found: ReadonlyArray<Db.SimilarRepo>) => found.map((entry) => entry.repo.id);

// similarCandidate as the app's code writes it, so the triggers that keep similar_candidates are held to it.
const candidates = drizzle.mock().select({ id: repos.id }).from(repos).where(similarCandidate(repos)).toSQL().sql;

const similarCases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("inStars ranks the account's own stars by distance and leaves the repo out", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(901);
      const opened = repoId(9101);
      const near = repoId(9102);
      const mid = repoId(9103);
      const far = repoId(9104);
      const gone = repoId(9105);
      const theirs = repoId(9106);
      yield* seed([
        { id: opened, axis: 10, lean: 0 },
        { id: near, axis: 10, lean: 0.1 },
        { id: mid, axis: 10, lean: 0.5, archived: true },
        { id: far, axis: 10, lean: 3 },
        { id: gone, axis: 10, lean: 0.05 },
        { id: theirs, axis: 10, lean: 0.01 },
      ]);
      yield* star(owner, [opened, near, mid, far, gone]);
      yield* star(accountId(902), [theirs]);
      yield* database.query("update repos set gone_at = now() where id = $1", [gone]);

      const found = yield* db.similar.inStars({ accountId: owner, repoId: opened, limit: 5 });

      expect(ids(found)).toEqual([near, mid, far]);
      expect(ids(yield* db.similar.inStars({ accountId: owner, repoId: opened, limit: 2 }))).toEqual([near, mid]);
    }),
  );

  test.effect("notStarred ranks summarized live repos the account hasn't starred", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(911);
      const opened = repoId(9201);
      const mine = repoId(9202);
      const near = repoId(9203);
      const waiting = repoId(9204);
      const archived = repoId(9205);
      const gone = repoId(9206);
      const unstarred = repoId(9207);
      const far = repoId(9208);
      yield* seed([
        { id: opened, axis: 20, lean: 0 },
        { id: mine, axis: 20, lean: 0.01 },
        { id: near, axis: 20, lean: 0.1 },
        { id: waiting, axis: 20, lean: 0.02, summary: false },
        { id: archived, axis: 20, lean: 0.03, archived: true },
        { id: gone, axis: 20, lean: 0.04 },
        { id: unstarred, axis: 20, lean: 0.2 },
        { id: far, axis: 20, lean: 3 },
      ]);
      yield* star(owner, [opened, mine, unstarred]);
      yield* database.query("update stars set unstarred_at = now() where account_id = $1 and repo_id = $2", [
        owner,
        unstarred,
      ]);
      yield* database.query("update repos set gone_at = now() where id = $1", [gone]);

      const found = yield* db.similar.notStarred({ accountId: owner, repoId: opened, limit: 5 });

      // An unstarred repo is one the account doesn't star now, so it comes back.
      expect(ids(found).filter((id) => id >= 9201 && id <= 9208)).toEqual([near, unstarred, far]);
    }),
  );

  test.effect("both rows are empty for a repo without an embedding of the configured model", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(921);
      const plain = repoId(9301);
      const foreign = repoId(9302);
      const near = repoId(9303);
      yield* db.repos.upsertRefs([ref(plain)]);
      yield* seed([
        { id: foreign, axis: 30, lean: 0 },
        { id: near, axis: 30, lean: 0.1 },
      ]);
      yield* database.query("update repos set embedding_model = 'test/other-embedding' where id = $1", [foreign]);
      yield* star(owner, [plain, foreign, near]);

      for (const repoId of [plain, foreign]) {
        const query = { accountId: owner, repoId, limit: 5 };
        expect(yield* db.similar.inStars(query)).toEqual([]);
        expect(yield* db.similar.notStarred(query)).toEqual([]);
      }
      // A repo of another model is never a neighbor either.
      const fromNear = yield* db.similar.inStars({ accountId: owner, repoId: near, limit: 5 });
      expect(ids(fromNear)).toEqual([]);
    }),
  );

  test.effect("the triggers keep similar_candidates to the candidates as their repos change", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const held = Effect.gen(function* () {
        const rows = yield* database.query(
          `select repo_id::float8 as id, embedding::text as embedding from similar_candidates where repo_id between 9501 and 9599 order by repo_id`,
        );
        const wanted = yield* database.query(
          `select id::float8 as id, embedding::text as embedding from repos where id between 9501 and 9599 and id in (${candidates}) order by id`,
        );
        expect(rows).toEqual(wanted);
        return (rows as ReadonlyArray<{ readonly id: number }>).map((row) => row.id);
      });
      const kept = repoId(9501);
      const archived = repoId(9502);
      const gone = repoId(9503);
      const waiting = repoId(9504);
      const moved = repoId(9505);
      yield* seed([
        { id: kept, axis: 50, lean: 0 },
        { id: archived, axis: 50, lean: 0.1 },
        { id: gone, axis: 50, lean: 0.2 },
        { id: waiting, axis: 50, lean: 0.3, summary: false },
        { id: moved, axis: 50, lean: 0.4 },
      ]);
      expect(yield* held).toEqual([kept, archived, gone, moved]);

      yield* db.repos.saveFacts({ ...facts(archived), archived: true });
      yield* database.query("update repos set gone_at = now() where id = $1", [gone]);
      yield* database.query("update repos set embedding = $1::halfvec where id = $2", [
        `[${leaning(51, 0).vector.join(",")}]`,
        moved,
      ]);
      expect(yield* held).toEqual([kept, moved]);

      // A write that leaves those four columns alone, such as a star, writes nothing to the table.
      yield* database.query(
        "update repos set synced_stargazers = synced_stargazers + 1 where id between 9501 and 9599",
      );
      yield* db.repos.saveFacts({ ...facts(archived), archived: false });
      expect(yield* held).toEqual([kept, archived, moved]);
    }),
  );

  test.effect("carries the repo's star count", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(931);
      const opened = repoId(9401);
      const near = repoId(9402);
      yield* seed([
        { id: opened, axis: 40, lean: 0 },
        { id: near, axis: 40, lean: 0.1 },
      ]);
      yield* star(owner, [opened, near]);
      yield* database.query("insert into repo_metrics (repo_id, stars, refreshed_at) values ($1, 1200, now())", [near]);

      const [found] = yield* db.similar.inStars({ accountId: owner, repoId: opened, limit: 5 });

      expect(found?.stars).toBe(1200);
      expect(found?.repo.name).toBe(ref(near).name);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite similar", similarCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "Postgres similar",
  similarCases,
);
