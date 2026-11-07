import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Db from "../src/db.ts";
import { createMigratedDatabase, dropDatabase } from "../src/local-database.ts";
import * as Memory from "../src/memory.ts";
import { acquirePool, driver } from "../src/node-postgres.ts";
import * as Postgres from "../src/postgres.ts";

export const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";

type DbLayer = ReturnType<typeof Db.layerNodePostgres>;

export class TestDatabase extends Context.Service<
  TestDatabase,
  {
    readonly query: (text: string, values?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>>;
    readonly connect: (options: Db.Options) => DbLayer;
    readonly url: Option.Option<string>;
  }
>()("@stargrep/db/test/database/TestDatabase") {}

const testDatabase = (
  query: (text: string, values: Array<unknown>) => Promise<{ rows: Array<unknown> }>,
  connect: (options: Db.Options) => DbLayer,
  url: Option.Option<string>,
) =>
  Layer.succeed(
    TestDatabase,
    TestDatabase.of({
      query: Effect.fn("TestDatabase.query")(function* (text: string, values: ReadonlyArray<unknown> = []) {
        return (yield* Effect.promise(() => query(text, [...values]))).rows;
      }),
      connect,
      url,
    }),
  );

export const layerMemory = (options: Db.Options) =>
  Layer.unwrap(
    Effect.map(Memory.open, (pglite) =>
      Layer.merge(
        Memory.layerPglite(pglite, options),
        testDatabase(
          (text, values) => pglite.client.query(text, values),
          (connectOptions) => Memory.layerPglite(pglite, connectOptions),
          Option.none(),
        ),
      ),
    ),
  );

const freshDatabase = Effect.gen(function* () {
  const name = `stargrep_test_${yield* Random.nextIntBetween(0, 2 ** 31)}`;
  const url = yield* Effect.acquireRelease(createMigratedDatabase(adminUrl, name), () => dropDatabase(adminUrl, name));
  const pool = yield* acquirePool(url);
  return { url: Redacted.make(url), pool };
});

export const layerNodePostgres = (options: Db.Options) =>
  Layer.unwrap(
    Effect.map(freshDatabase, ({ url, pool }) => {
      const connect = (settings: Db.Options) =>
        Db.layer(settings).pipe(Layer.provide(Layer.succeed(Postgres.Postgres, Postgres.make(driver(pool)))));
      return Layer.merge(
        connect(options),
        testDatabase((text, values) => pool.query(text, values), connect, Option.some(Redacted.value(url))),
      );
    }),
  );
