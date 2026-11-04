// @effect-diagnostics nodeBuiltinImport:off - test-only setup, and packages/db provides no FileSystem layer.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { messages, PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as runMigrations } from "drizzle-orm/pglite/migrator";
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

const version = (name: string): string =>
  JSON.parse(readFileSync(new URL(import.meta.resolve(`${name}/package.json`)), "utf8")).version;

const migrationsHash = () => {
  const hash = createHash("sha256");
  hash.update(`${version("@electric-sql/pglite")} ${version("@electric-sql/pglite-pgvector")}`);
  for (const file of readdirSync(migrationsFolder, { recursive: true, encoding: "utf8" }).sort()) {
    const path = join(migrationsFolder, file);
    if (statSync(path).isFile()) hash.update(`\0${file}\0`).update(readFileSync(path));
  }
  return hash.digest("hex").slice(0, 16);
};

// initdb is most of PGlite's startup, several seconds on a loaded machine, and
// every test file pays it. So each database starts from one migrated data
// directory, built once per PGlite version and migration set and kept in the
// temp directory for every later process. A rename publishes it whole.
const loadOrMigrate = async (): Promise<Blob> => {
  const path = join(tmpdir(), "stargrep-pglite", `${migrationsHash()}.tar`);
  const cached = Bun.file(path);
  if (await cached.exists()) return cached;
  const client = await PGlite.create({ extensions: { vector } });
  await runMigrations(drizzle({ client }), { migrationsFolder });
  const dataDir = await client.dumpDataDir("none");
  await client.close();
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}`;
  await Bun.write(partial, dataDir);
  renameSync(partial, path);
  return dataDir;
};

let migrated: Promise<Blob> | undefined;
const migratedDataDir = () => {
  migrated ??= loadOrMigrate();
  return migrated;
};

export const open = Effect.acquireRelease(
  Effect.gen(function* () {
    const client = yield* Effect.promise(async () =>
      PGlite.create({ extensions: { vector }, loadDataDir: await migratedDataDir() }),
    );
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
