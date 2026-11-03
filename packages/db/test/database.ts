import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import pg from "pg";

const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
const migrationsFolder = new URL("../migrations", import.meta.url).pathname;

export class TestDatabase extends Context.Service<
  TestDatabase,
  {
    readonly url: Redacted.Redacted<string>;
    readonly query: (text: string, values?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>>;
  }
>()("@stargrep/db/test/database/TestDatabase") {}

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

export const layer = Layer.effect(
  TestDatabase,
  Effect.gen(function* () {
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
    return TestDatabase.of({
      url: Redacted.make(url.href),
      query: Effect.fn("TestDatabase.query")(function* (text: string, values: ReadonlyArray<unknown> = []) {
        const result = yield* Effect.promise(() => pool.query(text, [...values]));
        return result.rows;
      }),
    });
  }),
);
