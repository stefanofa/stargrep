import { expect } from "bun:test";
import { summaryRecipe } from "@stargrep/ai/models";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import pg from "pg";
import * as Db from "../src/db.ts";
import { ignoreError } from "../src/node-postgres.ts";
import {
  enrichFailureCap,
  readingState,
  repos,
  stars,
  summaryPolicy,
  summaryUnwanted,
  unreadEnrichment,
} from "../src/schema.ts";
import * as TestDatabase from "./database.ts";
import {
  account,
  accountId,
  at,
  decodeWaiting,
  embedding,
  facts,
  login,
  model,
  readme,
  ref,
  repoId,
  starred,
} from "./fixtures.ts";
import { summarize } from "./summaries.ts";

const mock = drizzle.mock();

// The progress as it was counted before repo_reading, over every star's repos row, so the table is held to it.
const recount = (id: number) =>
  mock
    .select({
      total: sql`count(*)::int`.as("total"),
      read: sql`(count(*) filter (where not ${unreadEnrichment(repos)}))::int`.as("read"),
      failed:
        sql`(count(*) filter (where ${unreadEnrichment(repos)} and ${repos.enrichFailures} >= ${enrichFailureCap}))::int`.as(
          "failed",
        ),
      queued:
        sql`(count(*) filter (where ${unreadEnrichment(repos)} and (${repos.summaryDeferred} or ${summaryUnwanted(repos)}) and ${repos.enrichFailures} < ${enrichFailureCap} and ${repos.goneAt} is null))::int`.as(
          "queued",
        ),
    })
    .from(stars)
    .innerJoin(repos, eq(repos.id, stars.repoId))
    .where(and(eq(stars.accountId, id), isNull(stars.unstarredAt)))
    .toSQL();

// readingState as the app's code writes it, so the triggers and the backfill are held to it.
const wanted = mock
  .select({ id: sql`${repos.id}::float8`.as("id"), state: sql`${readingState(repos)}::text`.as("state") })
  .from(repos)
  .where(sql`${repos.id} between 7001 and 7099`)
  .orderBy(repos.id)
  .toSQL().sql;
const stored =
  "select repo_id::float8 as id, state::text from repo_reading where repo_id between 7001 and 7099 order by 1";

const reader = accountId(7001);
const readerLogin = login("progress-reader");
const ids = Array.from({ length: 8 }, (_, index) => repoId(7001 + index));
const [plain, popular, recipe, failing, deferred, held, gone, dropped] = ids as [
  RepoId,
  RepoId,
  RepoId,
  RepoId,
  RepoId,
  RepoId,
  RepoId,
  RepoId,
];

// The stored states match readingState for every repo, and the progress matches the recount.
const exact = Effect.gen(function* () {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  expect(yield* database.query(stored)).toEqual(yield* database.query(wanted));
  const { sql: text, params } = recount(reader);
  const [counted] = yield* database.query(text, params);
  const progress = yield* db.stars.enrichment(readerLogin);
  expect(progress).toEqual(counted as Db.EnrichmentProgress);
  return progress;
});

const read = Effect.fn("read")(function* (id: RepoId, readmeOid: ReturnType<typeof readme> | null = null) {
  const db = yield* Db.Db;
  if (readmeOid !== null) yield* db.repos.saveFacts({ ...facts(id), readmeOid });
  yield* summarize({ id, readmeOid, summary: `summary of ${id}`, keywords: [] });
  const row = yield* db.repos.require(id);
  yield* db.repos.saveEmbedding({
    id,
    owner: row.owner,
    name: row.name,
    summary: `summary of ${id}`,
    keywords: [],
    description: row.description,
    readmeOid,
    embedding: embedding({ 0: 1 }),
  });
});

const progressCases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("repo_reading and the progress match a recount through sync, enrichment, failure, and unstar", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const setStars = (id: RepoId, count: number) =>
        database.query("update repos set stars = $1 where id = $2", [count, id]);
      yield* db.accounts.upsert(account(reader, { login: readerLogin }));
      yield* db.accounts.upsert(account(accountId(7002)));

      // A sync brings in new repos and stars them.
      yield* db.repos.upsertRefs(ids.map((id) => ref(id)));
      yield* db.stars.upsert({ accountId: reader, stars: ids.map((id) => starred(id, "2026-01-01T00:00:00Z")) });
      expect(yield* exact).toEqual({ total: 8, read: 0, failed: 0, queued: 0 });

      // GitHub reports star counts, and the summary policy holds back the small repos that a signed-in user never starred.
      for (const id of ids) yield* setStars(id, summaryPolicy.stars);
      yield* setStars(held, 10);
      yield* setStars(gone, 10);
      expect(yield* exact).toEqual({ total: 8, read: 0, failed: 0, queued: 2 });

      // Enrichment reads repos, and one that gains a new README is due again.
      for (const id of [plain, popular, recipe]) yield* read(id, readme("1"));
      expect(yield* exact).toEqual({ total: 8, read: 3, failed: 0, queued: 2 });
      yield* db.repos.saveFacts({ ...facts(popular), readmeOid: readme("2") });
      expect(yield* exact).toEqual({ total: 8, read: 2, failed: 0, queued: 2 });
      yield* read(popular, readme("2"));

      // A summary from an older recipe leaves a repo read, and one without an embedding then counts as queued once the
      // policy holds it back.
      yield* database.query("update repos set summary_recipe = $1 where id = $2", [summaryRecipe - 1, recipe]);
      expect(yield* exact).toEqual({ total: 8, read: 3, failed: 0, queued: 2 });
      yield* database.query("update repos set embedding = null, embedding_model = null, stars = 10 where id = $1", [
        recipe,
      ]);
      expect(yield* exact).toEqual({ total: 8, read: 2, failed: 0, queued: 3 });

      // Failures reach the cap, the daily cap defers a summary, and a gone repo is never queued.
      const fail = db.repos.recordEnrichFailures({ ids: [failing], at: at("2026-05-01T00:00:00Z"), retryDelays: [] });
      for (let count = 0; count < enrichFailureCap; count++) yield* fail;
      const now = at("2026-05-01T00:00:00Z");
      const until = at("2026-05-01T00:15:00Z");
      expect(yield* db.repos.lease({ ids: [deferred], now, until })).toEqual([deferred]);
      yield* db.repos.defer({ ids: [deferred], until, retryAt: until });
      yield* database.query("update repos set gone_at = now() where id = $1", [gone]);
      expect(yield* exact).toEqual({ total: 8, read: 2, failed: 1, queued: 3 });

      // A signed-in user's star makes the policy want a held repo, and a write that moves no state, such as a star
      // that moves a stargazer count, leaves the table alone.
      yield* db.accounts.upsert(account(accountId(7003)));
      yield* db.stars.upsert({ accountId: accountId(7003), stars: [starred(held, "2026-02-01T00:00:00Z")] });
      yield* database.query("update repos set user_starred = true where id = $1", [held]);
      expect(yield* exact).toEqual({ total: 8, read: 2, failed: 1, queued: 2 });

      // An unstar drops a repo from the library, and a deleted repo takes its row with it.
      const kept = ids.filter((id) => id !== dropped).map((id) => starred(id, "2026-01-01T00:00:00Z"));
      yield* db.stars.applySnapshot({ accountId: reader, stars: kept, at: at("2026-06-01T00:00:00Z"), complete: true });
      expect(yield* exact).toEqual({ total: 7, read: 2, failed: 1, queued: 2 });
      yield* database.query("delete from repos where id = $1", [dropped]);
      expect(yield* exact).toEqual({ total: 7, read: 2, failed: 1, queued: 2 });

      // A repo with no row yet, as before the backfill reaches it, still counts by its repos row.
      yield* database.query("delete from repo_reading where repo_id between 7001 and 7099");
      const { sql: text, params } = recount(reader);
      expect(yield* db.stars.enrichment(readerLogin)).toEqual(
        (yield* database.query(text, params))[0] as Db.EnrichmentProgress,
      );
      expect(yield* db.stars.enrichment(readerLogin)).toEqual({ total: 7, read: 2, failed: 1, queued: 2 });
    }),
  );
};

const lockWaits = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  ),
).pipe(
  Effect.flatMap(decodeWaiting),
  Effect.map((rows) => rows[0]?.waiting ?? 0),
);

const backfill = (url: string) =>
  Effect.promise(async () => {
    const running = Bun.spawn(["bun", "scripts/backfill-reading.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATABASE_URL: url },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      running.exited,
      new Response(running.stdout).text(),
      new Response(running.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}${stderr}` };
  });

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite progress", progressCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "node-postgres progress",
  (test) => {
    progressCases(test);

    test.effect("backfill-reading writes the missing states once, and a rerun writes none", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const url = Option.getOrThrow(database.url);
        const [waiting, done] = [repoId(7051), repoId(7052)];
        yield* db.repos.upsertRefs([ref(waiting), ref(done)]);
        yield* read(done);
        yield* database.query("delete from repo_reading");

        const first = yield* backfill(url);
        expect(first.exitCode).toBe(0);
        expect(yield* database.query(stored)).toEqual(yield* database.query(wanted));
        const [{ count }] = (yield* database.query("select count(*)::int as count from repos")) as [{ count: number }];
        expect(first.output).toContain(`${count} repos read, ${count} states written`);

        const again = yield* backfill(url);
        expect(again.output).toContain(`${count} repos read, 0 states written`);
      }),
    );

    test.effect("a backfill that reads a state a writer is changing keeps the writer's state", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const url = Option.getOrThrow(database.url);
        const moving = repoId(7061);
        yield* db.repos.upsertRefs([ref(moving)]);
        yield* database.query("delete from repo_reading");
        const writer = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const connected = new pg.Client({ connectionString: url });
            connected.on("error", ignoreError);
            await connected.connect();
            return connected;
          }),
          (connected) => Effect.promise(() => connected.end()),
        );

        yield* Effect.promise(() => writer.query("begin"));
        yield* Effect.promise(() => writer.query("update repos set summary_deferred = true where id = $1", [moving]));
        const running = yield* Effect.forkChild(backfill(url));
        yield* lockWaits.pipe(Effect.repeat({ until: (waiting) => waiting >= 1 }));
        yield* Effect.promise(() => writer.query("commit"));
        expect((yield* Fiber.join(running)).exitCode).toBe(0);

        expect(yield* database.query(stored)).toEqual(yield* database.query(wanted));
        expect(yield* database.query("select state::text from repo_reading where repo_id = $1", [moving])).toEqual([
          { state: "queued" },
        ]);
      }),
    );
  },
);
