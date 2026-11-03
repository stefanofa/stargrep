import { expect } from "bun:test";
import { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Db from "../src/db.ts";
import { Embedding, EmbeddingModelId } from "../src/embedding.ts";
import * as TestDatabase from "./database.ts";

const model = Schema.decodeSync(EmbeddingModelId)("test/embedding-1024");
const otherModel = Schema.decodeSync(EmbeddingModelId)("test/other-embedding");
const accountId = Schema.decodeSync(GitHubAccountId);
const repoId = Schema.decodeSync(RepoId);
const login = Schema.decodeSync(Login);
const repoName = Schema.decodeSync(RepoName);
const at = (iso: string) => DateTime.makeUnsafe(iso);
const iso = (time: DateTime.Utc | null) => (time === null ? null : DateTime.formatIso(time));

const embedding = (weights: Readonly<Record<number, number>>, embeddingModel = model) =>
  Schema.decodeSync(Embedding)({
    model: embeddingModel,
    vector: Array.from({ length: 1024 }, (_, index) => weights[index] ?? 0),
  });

const account = (id: GitHubAccountId, facts: Partial<Db.AccountFacts> = {}): Db.AccountFacts => ({
  id,
  type: "user",
  login: login(`user-${id}`),
  name: null,
  avatarUrl: null,
  followers: null,
  publicRepos: null,
  ownedRepoStars: null,
  ...facts,
});

const ref = (id: RepoId, name = `repo-${id}`): Db.RepoRef => ({ id, owner: login("owner"), name: repoName(name) });

const stars = (accountId: GitHubAccountId): Db.SearchScope => ({ kind: "stars", accountId });

const starred = (id: RepoId, starredAt: string) => ({ repoId: id, starredAt: at(starredAt), source: "api" as const });

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

  test.effect("keeps the last full sync time across an incremental sync", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(102);
      yield* db.accounts.upsert(account(id));
      yield* db.accounts.recordStarSync({ accountId: id, etag: "full", at: at("2026-10-01T00:00:00Z"), full: true });
      yield* db.accounts.recordStarSync({ accountId: id, etag: "next", at: at("2026-10-02T00:00:00Z"), full: false });

      const stored = Option.getOrThrow(yield* db.accounts.get(id));
      expect(stored.starsEtag).toBe("next");
      expect(iso(stored.starsSyncedAt)).toBe("2026-10-02T00:00:00.000Z");
      expect(iso(stored.starsFullSyncedAt)).toBe("2026-10-01T00:00:00.000Z");

      const missing = yield* db.accounts
        .recordStarSync({ accountId: accountId(999_998), etag: null, at: at("2026-10-02T00:00:00Z"), full: true })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("AccountNotFound");
    }),
  );

  test.effect("stores repo refs and follows renames", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [first, second] = [repoId(2001), repoId(2002)];
      yield* db.repos.upsertRefs([ref(first), ref(second)]);
      yield* db.repos.upsertRefs([ref(first, "renamed"), ref(second)]);

      expect(Option.getOrThrow(yield* db.repos.get(first)).name).toBe(repoName("renamed"));
      expect(Option.getOrThrow(yield* db.repos.get(second)).name).toBe(repoName(`repo-${second}`));
    }),
  );

  test.effect("reports stored repos without a summary as unenriched, in the order asked", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [fresh, summarized, alsoFresh, missing] = [repoId(2051), repoId(2052), repoId(2053), repoId(2059)];
      yield* db.repos.upsertRefs([ref(fresh), ref(summarized), ref(alsoFresh)]);
      yield* db.repos.saveSummary({ id: summarized, readmeOid: null, summary: "done", keywords: [], kind: "app" });

      expect(yield* db.repos.unenriched([alsoFresh, missing, summarized, fresh])).toEqual([alsoFresh, fresh]);
      yield* db.repos.upsertRefs([ref(fresh), ref(summarized), ref(alsoFresh)]);
      expect(yield* db.repos.unenriched([fresh, summarized, alsoFresh])).toEqual([fresh, alsoFresh]);
    }),
  );

  test.effect("saves repo facts and reads them back", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2101);
      yield* db.repos.saveFacts({
        ...ref(id),
        description: "A terminal UI kit",
        topics: ["tui", "rust"],
        language: "Rust",
        license: "MIT",
        homepage: null,
        createdAt: at("2020-01-02T03:04:05Z"),
        pushedAt: null,
        archived: true,
      });

      const stored = Option.getOrThrow(yield* db.repos.get(id));
      expect(stored).toMatchObject({ topics: ["tui", "rust"], language: "Rust", archived: true, summary: null });
      expect(iso(stored.createdAt)).toBe("2020-01-02T03:04:05.000Z");
      expect(Option.isNone(yield* db.repos.get(repoId(2199)))).toBe(true);
    }),
  );

  test.effect("clears the embedding when a new summary lands", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = repoId(2201);
      yield* db.repos.upsertRefs([ref(id)]);
      yield* db.repos.saveEmbedding({ id, embedding: embedding({ 0: 1 }) });
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

      const error = yield* db.repos.saveEmbedding({ id, embedding: embedding({ 0: 1 }, otherModel) }).pipe(Effect.flip);
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
      const vector = yield* db.repos.saveEmbedding({ id, embedding: embedding({ 0: 1 }) }).pipe(Effect.flip);
      expect([summary._tag, vector._tag]).toEqual(["RepoNotFound", "RepoNotFound"]);
    }),
  );

  test.effect("stores the same star once", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(301);
      const repo = repoId(3001);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });

      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([repo]);
    }),
  );

  test.effect("rejects a star for an account that does not exist", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const repo = repoId(3101);
      yield* db.repos.upsertRefs([ref(repo)]);

      const error = yield* db.stars
        .upsert({ accountId: accountId(999_997), stars: [starred(repo, "2026-01-01T00:00:00Z")] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DbQueryFailed", reason: "constraint", sqlState: "23503" });
    }),
  );

  test.effect("lists active stars newest first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(302);
      const [old, newest, middle] = [repoId(3201), repoId(3202), repoId(3203)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(old), ref(newest), ref(middle)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [
          starred(old, "2026-01-01T00:00:00Z"),
          starred(newest, "2026-03-01T00:00:00Z"),
          starred(middle, "2026-02-01T00:00:00Z"),
        ],
      });

      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([newest, middle, old]);
    }),
  );

  test.effect("marks stars missing from a full list as unstarred, once", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(303);
      const [kept, gone, alsoGone] = [repoId(3301), repoId(3302), repoId(3303)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(kept), ref(gone), ref(alsoGone)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [kept, gone, alsoGone].map((repo) => starred(repo, "2026-01-01T00:00:00Z")),
      });

      const unstar = { accountId: id, keep: [kept], at: at("2026-02-01T00:00:00Z") };
      expect(yield* db.stars.markUnstarred(unstar)).toBe(2);
      expect(yield* db.stars.markUnstarred(unstar)).toBe(0);
      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([kept]);
    }),
  );

  test.effect("brings back a star starred again after its unstar, but not a replay of the old star", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(304);
      const repo = repoId(3401);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      yield* db.stars.markUnstarred({ accountId: id, keep: [], at: at("2026-02-01T00:00:00Z") });

      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      expect(yield* db.stars.list(id)).toEqual([]);

      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-03-01T00:00:00Z")] });
      const [star] = yield* db.stars.list(id);
      expect(star?.unstarredAt).toBeNull();
      expect(iso(star?.starredAt ?? null)).toBe("2026-03-01T00:00:00.000Z");
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
        yield* db.repos.saveEmbedding({ id, embedding: embedding(weights) });
      }
      yield* db.stars.upsert({
        accountId: owner,
        stars: [same, close, far, unstarred].map((id) => starred(id, "2026-01-01T00:00:00Z")),
      });
      yield* db.stars.upsert({ accountId: other, stars: [starred(notMine, "2026-01-01T00:00:00Z")] });
      yield* db.stars.markUnstarred({ accountId: owner, keep: [same, close, far], at: at("2026-02-01T00:00:00Z") });

      const query = { scope: stars(owner), text: "", embedding: embedding({ 0: 1 }) };
      const hits = yield* db.search.hybrid({ ...query, limit: 10 });
      expect(hits.map((hit) => [hit.repo.id, hit.textRank, hit.vectorRank])).toEqual([
        [same, null, 1],
        [close, null, 2],
        [far, null, 3],
      ]);
      expect((yield* db.search.hybrid({ ...query, limit: 2 })).map((hit) => hit.repo.id)).toEqual([same, close]);

      const refused = yield* db.search
        .hybrid({ ...query, embedding: embedding({ 0: 1 }, otherModel), limit: 10 })
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
        yield* db.repos.saveEmbedding({ id: repo, embedding: embedding(weights) });
      }
      yield* db.stars.upsert({
        accountId: id,
        stars: [textOnly, both, vectorOnly, neither].map((repo) => starred(repo, "2026-01-01T00:00:00Z")),
      });

      const hits = yield* db.search.hybrid({
        scope: stars(id),
        text: "terminal dashboard",
        embedding: embedding({ 0: 1 }),
        limit: 10,
      });
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
      yield* db.repos.saveEmbedding({ id: current, embedding: embedding({ 0: 1, 1: 1 }) });
      yield* db.repos.saveEmbedding({ id: stale, embedding: embedding({ 0: 1 }) });
      yield* db.stars.upsert({
        accountId: id,
        stars: [starred(current, "2026-01-01T00:00:00Z"), starred(stale, "2026-01-01T00:00:00Z")],
      });
      yield* database.query(`update repos set embedding_model = 'old/model' where id = $1`, [stale]);

      const hits = yield* db.search.hybrid({ scope: stars(id), text: "", embedding: embedding({ 0: 1 }), limit: 10 });
      expect(hits.map((hit) => hit.repo.id)).toEqual([current]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }))("PGlite Db", sharedCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }))("node-postgres Db", sharedCases);

const password = "p3-test-secret";

it.effect("reports an unreachable Postgres as a transport failure that holds no credential", () =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const error = yield* db.accounts.get(accountId(1)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "DbQueryFailed", operation: "accounts.get", reason: "transport" });

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
  }).pipe(
    Effect.provide(
      Db.layerNodePostgres({
        connectionString: Redacted.make(`postgres://stargrep:${password}@127.0.0.1:1/stargrep`),
        embeddingModel: model,
      }),
    ),
  ),
);
