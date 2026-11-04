import { messages, PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Db from "./db.ts";
import { migrationsFolder } from "./migrations.ts";
import * as Postgres from "./postgres.ts";

export interface Pglite {
  readonly client: PGlite;
  readonly driver: Postgres.Driver;
}

export const open = Effect.acquireRelease(
  Effect.gen(function* () {
    const client = yield* Effect.promise(async () => {
      const client = await PGlite.create({ extensions: { vector } });
      await migrate(drizzle({ client }), { migrationsFolder });
      return client;
    });
    // PGlite has one connection, so a transaction and every query outside it take turns.
    const turn = yield* Semaphore.make(1);
    const database = drizzle({ client });
    const driver: Postgres.Driver = {
      database,
      connect: async () => ({ database, query: (statement) => client.query(statement), release: () => undefined }),
      isDatabaseError: (error) => error instanceof messages.DatabaseError,
      exclusive: turn.withPermits(1),
    };
    return { client, driver } satisfies Pglite;
  }),
  ({ client }) => Effect.promise(() => client.close()),
);

export const layerPglite = (pglite: Pglite, options: Db.Options) =>
  Db.layer(options).pipe(Layer.provide(Layer.succeed(Postgres.Postgres, Postgres.make(pglite.driver))));

export const layerMemory = (options: Db.Options) =>
  Layer.unwrap(Effect.map(open, (pglite) => layerPglite(pglite, options)));
