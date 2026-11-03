import { messages, PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Db from "./db.ts";
import { migrationsFolder } from "./migrations.ts";
import * as Postgres from "./postgres.ts";

export const open = Effect.acquireRelease(
  Effect.promise(async () => {
    const client = await PGlite.create({ extensions: { vector } });
    await migrate(drizzle({ client }), { migrationsFolder });
    return client;
  }),
  (client) => Effect.promise(() => client.close()),
);

const driver = (client: PGlite): Postgres.Driver => {
  const database = drizzle({ client });
  return {
    database,
    // PGlite has one connection, so a query from another fiber during a transaction runs inside it.
    connect: async () => ({ database, query: (statement) => client.query(statement), release: () => undefined }),
    isDatabaseError: (error) => error instanceof messages.DatabaseError,
  };
};

export const layerPglite = (client: PGlite, options: Db.Options) =>
  Db.layer(options).pipe(Layer.provide(Layer.succeed(Postgres.Postgres, Postgres.make(driver(client)))));

export const layerMemory = (options: Db.Options) =>
  Layer.unwrap(Effect.map(open, (client) => layerPglite(client, options)));
