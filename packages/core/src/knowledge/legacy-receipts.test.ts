import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { RepoId } from "@stargrep/github/schemas";
import { legacyFacets } from "@stargrep/knowledge/claims";
import { InputHash } from "@stargrep/knowledge/ids";
import { legacyHash } from "@stargrep/knowledge/input-hash";
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
       keywords, kind, summary_recipe)
     select id, 'legacy', 'repo-' || id, 'A repo numbered ' || id, '["legacy"]', language, $2, $2,
       'Legacy summary of ' || id, keywords, kind, 1
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

// The summary a repo shows next to the summary its receipt holds, which must be the same.
const shown = Effect.fn("shown")(function* (id: number) {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query(
    `select r.summary, c.summary as receipt, (select count(*)::int from receipts where repo_id = r.id) as receipts
     from repos r join receipts c on c.id = r.receipt_id where r.id = $1`,
    [id],
  );
  return row;
});

// A Worker from before receipts summarizing a repo again: a new README, summary, keywords, and kind in one write.
const summarize = Effect.fn("summarize")(function* (
  id: number,
  readme: string,
  summary: string,
  kind: string,
  keywords: ReadonlyArray<string> = [],
) {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(
    `update repos set readme_oid = $2, summary_readme_oid = $2, summary = $3, kind = $4, keywords = $5::jsonb
     where id = $1`,
    [id, oid(readme), summary, kind, JSON.stringify(keywords)],
  );
});

// Waits, inside Postgres, up to five seconds for a session of this database to wait on a lock, and returns what the
// waiting sessions wait on.
const lockWait = Effect.gen(function* () {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(`
    do $$ begin
      for attempt in 1 .. 500 loop
        exit when exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock');
        perform pg_sleep(0.01);
      end loop;
    end $$`);
  const waiting = yield* database.query(
    "select wait_event as event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return waiting.map((row) => (row as { event: string }).event);
});

const cases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("every legacy kind projects as the primary kind and other as none, and keywords stay text", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const ids = yield* seed([
        { id: 1, kind: "cli", keywords: ["terminal ui", "framework", "rust"], language: "Rust" },
        { id: 2, kind: "library", keywords: ["terminal ui"] },
        { id: 3, kind: "other", keywords: [] },
        { id: 4, kind: "learning", keywords: ["***"] },
        { id: 5, kind: "app", keywords: [] },
      ]);
      const before = yield* database.query(
        "select md5(string_agg(id || ':' || kind, ',' order by id)) as h from repos",
      );

      expect(yield* keep(2)).toEqual({ pages: 4, read: 5, inserted: 5, pointed: 5 });
      expect(yield* RepoKnowledge.reproject()).toEqual({ projected: 5, minted: 0, conflicts: 0 });

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
      expect(
        yield* database.query(
          `select (select count(*)::int from repo_facets where stale) as stale,
             (select count(*)::int from subjects) as subjects,
             (select count(*)::int from repo_facets where cardinality(about) > 0) as "withAbout"`,
        ),
      ).toEqual([{ stale: 0, subjects: 0, withAbout: 0 }]);

      const [receipt] = yield* database.query(
        "select source, model, recipe, input_hash as hash, keywords, claims, dropped from receipts where repo_id = 1",
      );
      expect(receipt).toEqual({
        source: "legacy",
        model: "legacy",
        recipe: 1,
        hash: yield* legacyHash(
          {
            readmeOid: oid("1"),
            fullName: "legacy/repo-1",
            description: "A repo numbered 1",
            topics: ["legacy"],
            language: "Rust",
          },
          { summary: "Legacy summary of 1", keywords: ["terminal ui", "framework", "rust"], kind: "cli" },
        ).pipe(Effect.provide(Digest.layerWebCrypto)),
        keywords: ["terminal ui", "framework", "rust"],
        claims: legacyFacets({ kind: "cli" }).claims,
        dropped: [],
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

      yield* summarize(5, "2", "A new summary", "framework", ["web framework"]);
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
    }),
  );

  test.effect("a receipt follows each summary column, and a facts change alone makes none", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      yield* seed([{ id: 7, kind: "cli", keywords: ["dotfiles"] }]);
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });
      const receiptOf7 = Effect.map(
        database.query(
          "select c.keywords, c.recipe from repos r join receipts c on c.id = r.receipt_id where r.id = 7",
        ),
        (rows) => rows[0],
      );

      yield* database.query("update repos set description = 'An edited description' where id = 7");
      expect(yield* keep(4)).toMatchObject({ inserted: 0, pointed: 0 });
      yield* database.query(`update repos set keywords = '["dotfiles", "shell"]' where id = 7`);
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });
      expect(yield* receiptOf7).toEqual({ keywords: ["dotfiles", "shell"], recipe: 1 });
      yield* database.query("update repos set summary_recipe = 3 where id = 7");
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });
      expect(yield* receiptOf7).toEqual({ keywords: ["dotfiles", "shell"], recipe: 3 });
    }),
  );

  test.effect("a README back at an earlier version points the repo at the receipt of the summary it shows", () =>
    Effect.gen(function* () {
      yield* seed([{ id: 6, kind: "cli", keywords: ["dotfiles"] }]);
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });

      yield* summarize(6, "2", "A summary of the second README", "app");
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });
      expect(yield* shown(6)).toEqual({
        summary: "A summary of the second README",
        receipt: "A summary of the second README",
        receipts: 2,
      });

      yield* summarize(6, "1", "Legacy summary of 6", "cli", ["dotfiles"]);
      expect(yield* keep(4)).toMatchObject({ inserted: 0, pointed: 1 });
      expect(yield* shown(6)).toEqual({ summary: "Legacy summary of 6", receipt: "Legacy summary of 6", receipts: 2 });

      yield* summarize(6, "1", "A second summary of the first README", "library");
      expect(yield* keep(4)).toMatchObject({ inserted: 1, pointed: 1 });
      expect(yield* shown(6)).toEqual({
        summary: "A second summary of the first README",
        receipt: "A second summary of the first README",
        receipts: 3,
      });
      expect(yield* keep(4)).toMatchObject({ inserted: 0, pointed: 0 });
      yield* sweepAll;
      expect(yield* kinds([repoId(6)])).toEqual([{ id: 6, kind: "library", kinds: ["library"] }]);
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

// PGlite has one connection, so only Postgres can hold a row while a run or a sweep waits on it.
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres legacy receipts, concurrent",
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
        expect(yield* lockWait).toEqual(["transactionid"]);
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

    // A sweep that reaches a repo while a page holds it re-reads the row once the page commits, but not the receipt it
    // joined, so it sees the new receipt_id beside the old receipt's claims or none.
    test.effect("a sweep that waited while a page moved a repo's receipt leaves it stale for the next sweep", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const id = repoId(31);
        yield* seed([{ id: 31, kind: "cli", keywords: [] }]);
        yield* keep(4);
        yield* sweepAll;
        expect(yield* kinds([id])).toEqual([{ id: 31, kind: "cli", kinds: ["cli"] }]);

        yield* summarize(31, "2", "A summary of the second README", "library");
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query("update repo_facets set stale = true where repo_id = 31");
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const page = yield* Effect.forkChild(
          db.knowledge.keepLegacy({ after: 30, limit: 1 }, (repos) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
              return repos.map((repo) => ({
                repoId: repo.id,
                inputHash: InputHash.make("d".repeat(64)),
                recipe: repo.summaryRecipe,
                summary: repo.summary,
                keywords: repo.keywords,
                ...legacyFacets(repo),
              }));
            }),
          ),
        );
        yield* Deferred.await(read);
        const sweep = yield* Effect.forkChild(RepoKnowledge.reproject({ groupSize: 64, groups: 1 }));
        expect(yield* lockWait).toEqual(["transactionid"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(page)).toMatchObject({ inserted: 1, pointed: 1 });

        expect(yield* Fiber.join(sweep)).toEqual({ projected: 0, minted: 0, conflicts: 0 });
        expect(yield* database.query("select stale from repo_facets where repo_id = 31")).toEqual([{ stale: true }]);
        expect(yield* RepoKnowledge.reproject()).toEqual({ projected: 1, minted: 0, conflicts: 0 });
        expect(yield* kinds([id])).toEqual([{ id: 31, kind: "library", kinds: ["library"] }]);
      }),
    );
  },
);
