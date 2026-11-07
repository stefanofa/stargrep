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

export const dropDatabase = (adminUrl: string, name: string) =>
  withClient(adminUrl, async (client) => {
    // Disconnected backends can remain visible after pool.end resolves. DROP waits for them to exit.
    try {
      await client.query(`drop database if exists ${client.escapeIdentifier(name)}`);
    } catch (cause) {
      await client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`);
      throw cause;
    }
  });
