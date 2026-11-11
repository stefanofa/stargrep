import { expect } from "bun:test";
import { splitSqlStatements } from "@alchemy.run/sql/SqlFile";
import { closed, roles, traits } from "@stargrep/knowledge/registry";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import type pg from "pg";
import { databaseUrl, dropDatabase, withClient } from "../src/local-database.ts";
import { migrationsFolder } from "../src/migrations.ts";
import { adminUrl } from "./database.ts";

// A deploy applies each migration in one transaction and sends each chunk Alchemy's splitSqlStatements makes as its
// own round trip, a chunk of comments alone included. A lock on a table the running Workers may use lasts from the
// statement that takes it to the commit. So from the knowledge migration on, a migration locks a table that existed
// before it only in its last statement, which can be a DO block holding several commands. A table the migration
// creates is new to every running Worker, so the migration may lock it anywhere.

const migrations = Effect.promise(async () => {
  const folders = (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan(migrationsFolder))).sort();
  return Promise.all(
    folders.map(async (file) => ({
      file,
      statements: splitSqlStatements(await Bun.file(`${migrationsFolder}/${file}`).text()),
    })),
  );
});

// Every table in public before the migration begins, any of which a running Worker may use.
const existingTables = `select coalesce(array_agg(oid::int8), '{}') as oids from pg_class
  where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`;

const heldLocks = `select count(*)::int as locks from pg_locks
  where pid = pg_backend_pid() and locktype = 'relation' and relation::int8 = any($1::int8[])`;

// Applying every migration to a new database outgrows Bun's 5 s default under a parallel run.
it.layer(Layer.empty, { testTimeout: 60_000 })("migration locks", (test) =>
  test.effect("each migration from the knowledge one on locks the tables before it only in its last statement", () =>
    Effect.gen(function* () {
      const name = `stargrep_lock_${yield* Random.nextIntBetween(0, 2 ** 31)}`;
      yield* Effect.acquireRelease(
        withClient(adminUrl, (client) => client.query(`create database ${client.escapeIdentifier(name)}`)),
        () => dropDatabase(adminUrl, name),
      );
      const all = yield* migrations;
      const first = all.findIndex((migration) => migration.file.endsWith("_knowledge/migration.sql"));
      expect(first).toBeGreaterThan(0);
      const lockedFrom = yield* withClient(databaseUrl(adminUrl, name), async (client: pg.Client) => {
        const firstLocking: Record<string, number> = {};
        for (const [index, migration] of all.entries()) {
          const { rows: tables } = await client.query(existingTables);
          await client.query("begin");
          for (const [position, statement] of migration.statements.entries()) {
            await client.query(statement);
            if (index < first || migration.file in firstLocking) continue;
            const { rows } = await client.query(heldLocks, [tables[0].oids]);
            if (rows[0].locks > 0) firstLocking[migration.file] = position;
          }
          await client.query("commit");
        }
        return firstLocking;
      });
      const expected = Object.fromEntries(
        all
          .slice(first)
          .filter((migration) => migration.file in lockedFrom)
          .map((migration) => [migration.file, migration.statements.length - 1]),
      );
      expect(lockedFrom).toEqual(expected);
      expect(Object.keys(lockedFrom)).toContain(all[first]?.file ?? "no knowledge migration");
    }),
  ),
);

// Applies one migration in one transaction, statement by statement, as a deploy does.
const apply = async (client: pg.Client, statements: ReadonlyArray<string>) => {
  await client.query("begin");
  for (const statement of statements) await client.query(statement);
  await client.query("commit");
};

// Applies the migrations before the named one to a new database, runs setup, applies the rest, and reads the result.
const across = <A>(
  migration: string,
  setup: (client: pg.Client) => Promise<void>,
  read: (client: pg.Client) => Promise<A>,
) =>
  Effect.gen(function* () {
    const name = `stargrep_migration_${yield* Random.nextIntBetween(0, 2 ** 31)}`;
    yield* Effect.acquireRelease(
      withClient(adminUrl, (client) => client.query(`create database ${client.escapeIdentifier(name)}`)),
      () => dropDatabase(adminUrl, name),
    );
    const all = yield* migrations;
    const at = all.findIndex((entry) => entry.file.endsWith(`_${migration}/migration.sql`));
    expect([migration, at > 0]).toEqual([migration, true]);
    return yield* withClient(databaseUrl(adminUrl, name), async (client: pg.Client) => {
      for (const entry of all.slice(0, at)) await apply(client, entry.statements);
      await setup(client);
      for (const entry of all.slice(at)) await apply(client, entry.statements);
      return read(client);
    });
  });

const rows = async (client: pg.Client, text: string) => (await client.query(text)).rows;

const twoProjectedRepos = async (client: pg.Client) => {
  await client.query("insert into repos (id, owner, name) values (1, 'owner', 'one'), (2, 'owner', 'two')");
  await client.query("update repo_facets set stale = false");
};

const staleRepos = (client: pg.Client) =>
  rows(client, "select count(*) filter (where stale)::int as stale, count(*)::int as repos from repo_facets");

it.layer(Layer.empty, { testTimeout: 60_000 })("kinds migration", (test) =>
  test.effect("drops the subject labels the new kinds now own and has every repo project again", () =>
    Effect.gen(function* () {
      const after = yield* across(
        "kinds_database_system",
        async (client) => {
          await client.query(
            `insert into decisions (revision, kind, payload, actor, reason) values (1, 'create', '{"_tag":"Create"}', 'seed', 'seed')`,
          );
          const { rows: subjects } = await client.query(
            "insert into subjects (label, status, origin_revision) values ('database', 'accepted', 1) returning id",
          );
          await client.query(
            `insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
             select 'public', key, $1, key = 'database', 'decision', 1 from unnest(array['database', 'db', 'data store']) key`,
            [subjects[0].id],
          );
          await twoProjectedRepos(client);
        },
        async (client) => ({
          labels: await rows(client, "select key from subject_labels order by key"),
          stale: await staleRepos(client),
          kinds: await rows(client, "select unnest(enum_range(null::knowledge_kind))::text as kind"),
        }),
      );
      expect(after.labels).toEqual([{ key: "data store" }]);
      expect(after.stale).toEqual([{ stale: 2, repos: 2 }]);
      expect(after.kinds.slice(-2)).toEqual([{ kind: "database" }, { kind: "system-software" }]);
    }),
  ),
);

// Projection reads the closed registry, the roles, the trait list, and its own rules, and the sweep projects only stale repos. So an
// edit to any of them that moves no SQL, such as a new impliedBy name or a new projection rule, reaches the receipts
// already captured only
// through a migration that marks every repo stale. Write that migration, name it here, and record the new digest. An
// edit to projection.ts that projects every repo as before, such as a comment, may keep the migration and only record
// the digest.
const reprojection = {
  migration: "trait_list_recipe",
  digest: "132211b9cba0e6fac514820303d805f952020d55c84f16e8ea5235ebea2ccec3",
};

it.layer(Layer.empty, { testTimeout: 60_000 })("registry reprojection", (test) =>
  test.effect("names the migration that has every repo project again under the current registry and rules", () =>
    Effect.gen(function* () {
      const rules = yield* Effect.promise(() =>
        Bun.file(Bun.resolveSync("@stargrep/knowledge/projection", import.meta.dir)).text(),
      );
      const digest = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([closed, roles, traits]))
        .update(rules)
        .digest("hex");
      const stale = yield* across(reprojection.migration, twoProjectedRepos, staleRepos);
      expect({ ...reprojection, digest, stale }).toEqual({ ...reprojection, stale: [{ stale: 2, repos: 2 }] });
    }),
  ),
);
