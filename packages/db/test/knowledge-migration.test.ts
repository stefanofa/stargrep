import { expect } from "bun:test";
import { splitSqlStatements } from "@alchemy.run/sql/SqlFile";
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
