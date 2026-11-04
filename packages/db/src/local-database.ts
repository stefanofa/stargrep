import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as Effect from "effect/Effect";
import pg from "pg";
import { migrationsFolder } from "./migrations.ts";
import { acquirePool, ignoreError } from "./node-postgres.ts";

export const withClient = <A>(url: string, use: (client: pg.Client) => Promise<A>) =>
  Effect.promise(async () => {
    const client = new pg.Client({ connectionString: url });
    client.on("error", ignoreError);
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  });

export const databaseUrl = (adminUrl: string, name: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.href;
};

export const createMigratedDatabase = (adminUrl: string, name: string) =>
  withClient(adminUrl, async (client) => {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (rowCount === 0) await client.query(`create database ${client.escapeIdentifier(name)}`);
  }).pipe(
    Effect.andThen(
      acquirePool(databaseUrl(adminUrl, name)).pipe(
        Effect.flatMap((pool) => Effect.promise(() => migrate(drizzle({ client: pool }), { migrationsFolder }))),
        Effect.scoped,
      ),
    ),
    Effect.as(databaseUrl(adminUrl, name)),
  );

// Drops the database even when connections remain, then fails, because each one is a leak.
export const dropDatabase = (adminUrl: string, name: string) =>
  withClient(adminUrl, async (client) => {
    const { rows } = await client.query<{ open: number }>(
      "select count(*)::int as open from pg_stat_activity where datname = $1",
      [name],
    );
    await client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`);
    const open = rows[0]?.open ?? 0;
    if (open > 0) throw new Error(`${open} connections were still open on ${name} when it was dropped`);
  });
