import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import type pg from "pg";
import { databaseUrl, dropDatabase, withClient } from "../src/local-database.ts";
import { migrationsFolder } from "../src/migrations.ts";
import { adminUrl } from "./database.ts";

// A deploy applies each migration in one transaction and sends its statements one round trip at a time. A lock on a
// table the running Workers use lasts from the statement that takes it to the commit. So from the knowledge migration
// on, a migration takes those locks only in its last statement, which can be a DO block holding several commands.

const statementsOf = (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.replace(/^--.*$/gm, "").trim().length > 0);

const migrations = Effect.promise(async () => {
  const folders = (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan(migrationsFolder))).sort();
  return Promise.all(
    folders.map(async (file) => ({
      file,
      statements: statementsOf(await Bun.file(`${migrationsFolder}/${file}`).text()),
    })),
  );
});

// The tables the running Workers read and write. A new table joins this list once a deployed Worker uses it.
const hotTables = ["repos", "user", "stars", "github_accounts", "repo_metrics", "collection_items", "search_events"];

const heldLocks = `select count(*)::int as locks from pg_locks l join pg_class c on c.oid = l.relation
  where l.pid = pg_backend_pid() and c.relname = any($1::text[]) and c.relnamespace = 'public'::regnamespace`;

it.effect("each migration from the knowledge one on locks tables the Workers use only in its last statement", () =>
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
        await client.query("begin");
        for (const [position, statement] of migration.statements.entries()) {
          await client.query(statement);
          if (index < first || migration.file in firstLocking) continue;
          const { rows } = await client.query(heldLocks, [hotTables]);
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
);
