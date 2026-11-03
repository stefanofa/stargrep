import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import * as Db from "../src/db.ts";
import * as Memory from "../src/memory.ts";
import { migrationsFolder } from "../src/migrations.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";

type DbLayer = ReturnType<typeof Db.layerNodePostgres>;

export class TestDatabase extends Context.Service<
  TestDatabase,
  {
    readonly query: (text: string, values?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>>;
    readonly connect: (options: Db.Options) => DbLayer;
  }
>()("@stargrep/db/test/database/TestDatabase") {}

const testDatabase = (
  query: (text: string, values: Array<unknown>) => Promise<{ rows: Array<unknown> }>,
  connect: (options: Db.Options) => DbLayer,
) =>
  Layer.succeed(
    TestDatabase,
    TestDatabase.of({
      query: Effect.fn("TestDatabase.query")(function* (text: string, values: ReadonlyArray<unknown> = []) {
        return (yield* Effect.promise(() => query(text, [...values]))).rows;
      }),
      connect,
    }),
  );

export const layerMemory = (options: Db.Options) =>
  Layer.unwrap(
    Effect.map(Memory.open, (client) =>
      Layer.merge(
        Memory.layerPglite(client, options),
        testDatabase(
          (text, values) => client.query(text, values),
          (connectOptions) => Memory.layerPglite(client, connectOptions),
        ),
      ),
    ),
  );

const admin = (statement: string) =>
  Effect.promise(async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  });

const freshDatabase = Effect.gen(function* () {
  const name = `stargrep_test_${yield* Random.nextIntBetween(0, 2 ** 31)}`;
  yield* Effect.acquireRelease(admin(`create database ${name}`), () =>
    admin(`drop database if exists ${name} with (force)`),
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new pg.Pool({ connectionString: url.href })),
    (pool) => Effect.promise(() => pool.end()),
  );
  yield* Effect.promise(() => migrate(drizzle({ client: pool }), { migrationsFolder }));
  return { url: Redacted.make(url.href), pool };
});

export const layerNodePostgres = (options: Db.Options) =>
  Layer.unwrap(
    Effect.map(freshDatabase, ({ url, pool }) =>
      Layer.merge(
        Db.layerNodePostgres({ ...options, connectionString: url }),
        testDatabase(
          (text, values) => pool.query(text, values),
          (connectOptions) => Db.layerNodePostgres({ ...connectOptions, connectionString: url }),
        ),
      ),
    ),
  );
