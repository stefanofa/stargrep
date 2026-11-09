import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { RepoId } from "@stargrep/github/schemas";
import { inputHash } from "@stargrep/knowledge/input-hash";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as LegacyReceipts from "./legacy-receipts.ts";
import * as RepoKnowledge from "./repo-knowledge.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const repoId = Schema.decodeSync(RepoId);
const oid = (digit: string) => digit.repeat(40);

interface Legacy {
  readonly id: number;
  readonly kind: string;
  readonly keywords: ReadonlyArray<string>;
  readonly language?: string;
}

// Repos as enrichment left them before receipts: facts, a summary of the current README, keywords, and a kind.
const seed = Effect.fn("seed")(function* (repos: ReadonlyArray<Legacy>) {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(
    `insert into repos (id, owner, name, description, topics, language, readme_oid, summary_readme_oid, summary,
       keywords, kind)
     select id, 'legacy', 'repo-' || id, 'A repo numbered ' || id, '["legacy"]', language, $2, $2,
       'Legacy summary of ' || id, keywords, kind
     from jsonb_to_recordset($1::jsonb) as r (id bigint, kind text, keywords jsonb, language text)`,
    [JSON.stringify(repos.map((repo) => ({ language: null, ...repo }))), oid("1")],
  );
  return repos.map((repo) => repoId(repo.id));
});

const sweepAll = Effect.gen(function* () {
  for (let pass = 0; pass < 20; pass++) {
    const { projected } = yield* RepoKnowledge.reproject();
    if (projected === 0) return;
  }
});

const kinds = Effect.fn("kinds")(function* (ids: ReadonlyArray<RepoId>) {
  const database = yield* TestDatabase.TestDatabase;
  return yield* database.query(
    "select id::float8 as id, kind, kinds::text[] as kinds from repos where id = any($1::bigint[]) order by id",
    [ids],
  );
});

// The subject a label names, the repos a filter by its ID finds, and its listing after the nightly count.
const subjectNamed = Effect.fn("subjectNamed")(function* (label: string) {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query(
    `select s.id::float8 as id, s.repo_count as repos, s.listed,
       array(select repo_id::float8 from repo_facets where members && knowledge_origins(array[s.id], true)
             order by repo_id) as members
     from subjects s where s.label = $1`,
    [label],
  );
  return row as { readonly id: number; readonly repos: number; readonly listed: boolean; members: Array<number> };
});

const receiptsOf = Effect.fn("receiptsOf")(function* (ids: ReadonlyArray<RepoId>) {
  const database = yield* TestDatabase.TestDatabase;
  return yield* database.query(
    `select r.id::float8 as id, count(c.id)::int as receipts, bool_or(c.id = r.receipt_id) as pointed
     from repos r left join receipts c on c.repo_id = r.id where r.id = any($1::bigint[]) group by r.id order by r.id`,
    [ids],
  );
});

const keep = (pageSize: number) =>
  LegacyReceipts.keepLegacySummaries({ pageSize }).pipe(Effect.provide(Digest.layerWebCrypto));

const cases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("every legacy kind projects as the primary kind, other as none, and keywords mint listed subjects", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const ids = yield* seed([
        { id: 1, kind: "cli", keywords: ["shared widget kit", "framework", "rust"], language: "Rust" },
        { id: 2, kind: "library", keywords: ["shared widget kit", "lonely keyword"] },
        { id: 3, kind: "other", keywords: [] },
        { id: 4, kind: "learning", keywords: ["***"] },
        { id: 5, kind: "app", keywords: [] },
      ]);
      const before = yield* database.query(
        "select md5(string_agg(id || ':' || kind, ',' order by id)) as h from repos",
      );

      expect(yield* keep(2)).toEqual({ pages: 4, read: 5, inserted: 5, pointed: 5 });
      yield* sweepAll;
      yield* RepoKnowledge.count();

      expect(yield* kinds(ids)).toEqual([
        { id: 1, kind: "cli", kinds: ["cli"] },
        { id: 2, kind: "library", kinds: ["library"] },
        { id: 3, kind: "other", kinds: [] },
        { id: 4, kind: "learning", kinds: ["learning"] },
        { id: 5, kind: "app", kinds: ["app"] },
      ]);
      expect(
        yield* database.query("select md5(string_agg(id || ':' || kind, ',' order by id)) as h from repos"),
      ).toEqual(before);
      expect(yield* database.query("select count(*)::int as n from repo_facets where stale")).toEqual([{ n: 0 }]);
      const lonely = yield* subjectNamed("lonely keyword");
      expect([lonely.members, lonely.repos, lonely.listed]).toEqual([[2], 1, false]);
      const shared = yield* subjectNamed("shared widget kit");
      expect([shared.members, shared.repos, shared.listed]).toEqual([[1, 2], 2, true]);
      expect(
        yield* database.query("select count(*)::int as n from subjects where label in ('framework', 'rust')"),
      ).toEqual([{ n: 0 }]);

      const [receipt] = yield* database.query(
        "select source, model, recipe, input_hash as hash, dropped from receipts where repo_id = 4",
      );
      expect(receipt).toEqual({
        source: "legacy",
        model: "legacy",
        recipe: 1,
        hash: yield* inputHash({
          readmeOid: oid("1"),
          fullName: "legacy/repo-4",
          description: "A repo numbered 4",
          topics: ["legacy"],
          language: null,
        }).pipe(Effect.provide(Digest.layerWebCrypto)),
        dropped: [{ ordinal: 1, issue: "empty-term" }],
      });
    }),
  );

  test.effect("a rerun writes nothing, and a repo summarized again since gets a new receipt", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const ids = [1, 2, 3, 4, 5].map((id) => repoId(id));
      const versions = "select string_agg(xmin::text, ',' order by id) as v from repos";
      const before = yield* database.query(versions);
      expect(yield* keep(2)).toEqual({ pages: 4, read: 5, inserted: 0, pointed: 0 });
      expect(yield* database.query(versions)).toEqual(before);

      yield* database.query(
        `update repos set readme_oid = $1, summary_readme_oid = $1, summary = 'A new summary', kind = 'framework',
           keywords = '["lonely keyword"]'
         where id = 5`,
        [oid("2")],
      );
      expect(yield* keep(2)).toEqual({ pages: 4, read: 5, inserted: 1, pointed: 1 });
      yield* sweepAll;
      expect((yield* kinds([repoId(5)]))[0]).toEqual({ id: 5, kind: "framework", kinds: ["framework"] });
      expect(yield* receiptsOf(ids)).toEqual([
        { id: 1, receipts: 1, pointed: true },
        { id: 2, receipts: 1, pointed: true },
        { id: 3, receipts: 1, pointed: true },
        { id: 4, receipts: 1, pointed: true },
        { id: 5, receipts: 2, pointed: true },
      ]);
      yield* RepoKnowledge.count();
      expect((yield* subjectNamed("lonely keyword")).listed).toBe(true);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "PGlite legacy receipts",
  cases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres legacy receipts",
  cases,
);

// PGlite has one connection, so only Postgres can hold a row while a run waits on it.
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres legacy receipts, killed",
  (test) => {
    test.effect("a run killed mid-page keeps the pages before it, and a rerun finishes the rest with no repeats", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const ids = yield* seed([11, 12, 13, 14, 15, 16].map((id) => ({ id, kind: "cli", keywords: ["kill test"] })));
        const holding = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          db.knowledge.project([repoId(14)], () =>
            Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(release)).pipe(Effect.as([])),
          ),
        );
        yield* Deferred.await(holding);
        const run = yield* Effect.forkChild(Effect.exit(keep(2)));
        yield* database.query(`
          do $$ begin
            for attempt in 1 .. 500 loop
              exit when exists (
                select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock');
              perform pg_sleep(0.01);
            end loop;
          end $$`);
        const killed = yield* database.query(
          `select pg_terminate_backend(pid) as killed from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        expect(killed).toEqual([{ killed: true }]);
        const exit = yield* Fiber.join(run);
        expect(exit._tag).toBe("Failure");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);

        const counts = (rows: ReadonlyArray<unknown>) => rows.map((row) => (row as { receipts: number }).receipts);
        expect(counts(yield* receiptsOf(ids))).toEqual([1, 1, 0, 0, 0, 0]);
        expect(yield* keep(2)).toMatchObject({ inserted: 4, pointed: 4 });
        expect(yield* receiptsOf(ids)).toEqual(ids.map((id) => ({ id, receipts: 1, pointed: true })));
        expect(yield* keep(2)).toMatchObject({ inserted: 0, pointed: 0 });
      }),
    );
  },
);
