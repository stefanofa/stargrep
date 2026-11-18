import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import pg from "pg";
import * as Db from "../src/db.ts";
import { ignoreError } from "../src/node-postgres.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, at, decodeWaiting, model, ref, repoId, starred } from "./fixtures.ts";

const client = Effect.gen(function* () {
  const url = Option.getOrThrow((yield* TestDatabase.TestDatabase).url);
  return yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const connected = new pg.Client({ connectionString: url });
      connected.on("error", ignoreError);
      await connected.connect();
      return connected;
    }),
    (connected) => Effect.promise(() => connected.end()),
  );
});

const lockWaits = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  ),
).pipe(
  Effect.flatMap(decodeWaiting),
  Effect.map((rows) => rows[0]?.waiting ?? 0),
);

const untilWaiting = (count: number) => lockWaits.pipe(Effect.repeat({ until: (waiting) => waiting >= count }));

const lockRepo = (writer: pg.Client, id: RepoId) =>
  Effect.tryPromise(() => writer.query("select id from repos where id = $1 for no key update", [id])).pipe(
    Effect.asVoid,
  );

const storedCounts = (ids: ReadonlyArray<RepoId>) =>
  Effect.flatMap(TestDatabase.TestDatabase, (database) =>
    database.query(
      `select r.synced_stargazers as stored,
         (select count(*)::int from stars s where s.repo_id = r.id and s.unstarred_at is null) as current
       from repos r where r.id = any($1::bigint[]) order by r.id`,
      [ids],
    ),
  );

const countStargazers = (url: string) =>
  Effect.promise(async () => {
    const counting = Bun.spawn(["bun", "scripts/count-stargazers.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATABASE_URL: url },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      counting.exited,
      new Response(counting.stdout).text(),
      new Response(counting.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}${stderr}` };
  });

const countCases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("sets every surviving repo's count back to 0 when stars are truncated", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [ada, grace] = [accountId(8201), accountId(8202)];
      const [first, second] = [repoId(82_001), repoId(82_002)];
      for (const id of [ada, grace]) yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(first), ref(second)]);
      yield* db.stars.upsert({
        accountId: ada,
        stars: [starred(first, "2026-01-01T00:00:00Z"), starred(second, "2026-01-01T00:00:00Z")],
      });
      yield* db.stars.upsert({ accountId: grace, stars: [starred(first, "2026-01-01T00:00:00Z")] });

      yield* database.query("truncate stars");
      expect(yield* storedCounts([first, second])).toEqual([
        { stored: 0, current: 0 },
        { stored: 0, current: 0 },
      ]);

      yield* db.stars.upsert({ accountId: grace, stars: [starred(second, "2026-02-01T00:00:00Z")] });
      yield* database.query("truncate github_accounts cascade");
      expect(yield* storedCounts([first, second])).toEqual([
        { stored: 0, current: 0 },
        { stored: 0, current: 0 },
      ]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })(
  "PGlite stargazer counts",
  countCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "node-postgres stargazer counts",
  (test) => {
    countCases(test);

    // PGlite has one connection, so these run only where two transactions can interleave. Each plays a writer that locks
    // repos in ID order, as every multi-row writer of repos does, against a star write that changes two repos' counts.

    test.effect(
      "an upsert that stars one repo again and another anew never waits in a cycle with an ID-order writer",
      () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const id = accountId(8101);
          const [low, high] = [repoId(81_001), repoId(81_002)];
          yield* db.accounts.upsert(account(id));
          yield* db.repos.upsertRefs([ref(low), ref(high)]);
          yield* db.stars.upsert({ accountId: id, stars: [starred(high, "2026-01-01T00:00:00Z")] });
          yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-02-01T00:00:00Z"), complete: true });
          const writer = yield* client;

          yield* Effect.promise(() => writer.query("begin"));
          yield* lockRepo(writer, low);
          const upsert = yield* Effect.forkChild(
            db.stars.upsert({
              accountId: id,
              stars: [starred(low, "2026-03-01T00:00:00Z"), starred(high, "2026-03-01T00:00:00Z")],
            }),
          );
          yield* untilWaiting(1);
          const writerLocked = yield* Effect.exit(lockRepo(writer, high));
          yield* Effect.promise(() => writer.query(Exit.isSuccess(writerLocked) ? "commit" : "rollback"));
          const upserted = yield* Effect.exit(Fiber.join(upsert));

          expect([Exit.isSuccess(writerLocked), Exit.isSuccess(upserted)]).toEqual([true, true]);
          expect(yield* storedCounts([low, high])).toEqual([
            { stored: 1, current: 1 },
            { stored: 1, current: 1 },
          ]);
        }),
    );

    test.effect(
      "a snapshot that stars one repo and unstars another never waits in a cycle with an ID-order writer",
      () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const id = accountId(8102);
          const [low, high] = [repoId(81_011), repoId(81_012)];
          yield* db.accounts.upsert(account(id));
          yield* db.repos.upsertRefs([ref(low), ref(high)]);
          yield* db.stars.upsert({ accountId: id, stars: [starred(low, "2026-01-01T00:00:00Z")] });
          const writer = yield* client;

          yield* Effect.promise(() => writer.query("begin"));
          yield* lockRepo(writer, low);
          const snapshot = yield* Effect.forkChild(
            db.stars.applySnapshot({
              accountId: id,
              stars: [{ repoId: high, starredAt: at("2026-02-01T00:00:00Z"), source: "api" }],
              at: at("2026-02-01T00:00:00Z"),
              complete: true,
            }),
          );
          yield* untilWaiting(1);
          const writerLocked = yield* Effect.exit(lockRepo(writer, high));
          yield* Effect.promise(() => writer.query(Exit.isSuccess(writerLocked) ? "commit" : "rollback"));
          const applied = yield* Effect.exit(Fiber.join(snapshot));

          expect(Exit.isSuccess(writerLocked)).toBe(true);
          expect(applied).toEqual(Exit.succeed({ starred: [high], unstarred: [low] }));
          expect(yield* storedCounts([low, high])).toEqual([
            { stored: 0, current: 0 },
            { stored: 1, current: 1 },
          ]);
        }),
    );

    // The writer holds the high repo and then asks for the low one, out of ID order, so the batch that holds the low one
    // and waits for the high one is the side Postgres aborts: its deadlock check runs first, since it waited first.
    test.effect("count-stargazers retries a batch that loses a deadlock and counts the star that caused it once", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const id = accountId(8103);
        const [low, high] = [repoId(81_021), repoId(81_022)];
        yield* db.accounts.upsert(account(id));
        yield* db.repos.upsertRefs([ref(low), ref(high)]);
        yield* db.stars.upsert({ accountId: id, stars: [starred(low, "2026-01-01T00:00:00Z")] });
        yield* database.query("update repos set synced_stargazers = 0");
        const writer = yield* client;

        yield* Effect.promise(() => writer.query("begin"));
        yield* Effect.promise(() => writer.query("set local deadlock_timeout = '20s'"));
        yield* Effect.promise(() =>
          writer.query(
            "insert into stars (account_id, repo_id, starred_at, observed_at, source) values ($1, $2, $3, $3, 'api')",
            [id, high, "2026-02-01T00:00:00Z"],
          ),
        );
        const counting = yield* Effect.forkChild(countStargazers(Option.getOrThrow(database.url)));
        yield* untilWaiting(1);
        yield* lockRepo(writer, low);
        yield* Effect.promise(() => writer.query("commit"));
        const counted = yield* Fiber.join(counting);

        expect(counted.exitCode).toBe(0);
        expect(yield* storedCounts([low, high])).toEqual([
          { stored: 1, current: 1 },
          { stored: 1, current: 1 },
        ]);
      }),
    );
  },
);
