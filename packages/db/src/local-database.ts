import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as Effect from "effect/Effect";
import pg from "pg";
import { migrationsFolder } from "./migrations.ts";

export const withClient = <A>(url: string, use: (client: pg.Client) => Promise<A>) =>
  Effect.promise(async () => {
    const client = new pg.Client({ connectionString: url });
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
      Effect.promise(async () => {
        const pool = new pg.Pool({ connectionString: databaseUrl(adminUrl, name) });
        try {
          await migrate(drizzle({ client: pool }), { migrationsFolder });
        } finally {
          await pool.end();
        }
      }),
    ),
    Effect.as(databaseUrl(adminUrl, name)),
  );

export const dropDatabase = (adminUrl: string, name: string) =>
  withClient(adminUrl, (client) =>
    client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`),
  );
