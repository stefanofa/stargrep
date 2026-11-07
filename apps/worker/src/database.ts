import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import { migrationsFolder } from "@stargrep/db/migrations";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { settings } from "./stage.ts";

const localPostgres = {
  scheme: "postgres",
  host: "127.0.0.1",
  port: 54317,
  database: "stargrep",
  user: "stargrep",
  password: Redacted.make("stargrep"),
  sslmode: "disable",
} as const;

const extensions = new URL("../sql/extensions.sql", import.meta.url).pathname;

// Neon returns expires_at to the second and Alchemy compares it as a string, so drop the ".000".
const expiresIn = (days: number) =>
  DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.add(DateTime.startOf(now, "day"), { days })).replace(".000Z", "Z")),
  );

const StageBranch = Effect.gen(function* () {
  const { database, retain } = yield* settings;
  const project = yield* Neon.Project.ref(database.logicalId, {
    stack: "StargrepDatabase",
    stage: "shared",
  });
  const expiry = database.expiryDays === undefined ? {} : { expiresAt: yield* expiresIn(database.expiryDays) };
  return yield* Neon.Branch("Branch", {
    project,
    migrations: migrationsFolder,
    importFiles: [extensions],
    ...expiry,
  }).pipe(RemovalPolicy.retain(retain));
});

export const DatabaseMigrations = Effect.gen(function* () {
  return (yield* Alchemy.ALCHEMY_DEV) ? "local" : (yield* StageBranch).migrationsHashes;
});

export const Database = Effect.gen(function* () {
  const origin = (yield* Alchemy.ALCHEMY_DEV) ? localPostgres : (yield* StageBranch).origin;
  return yield* Cloudflare.Hyperdrive.Connection("Database", {
    origin,
    dev: localPostgres,
    caching: { disabled: true },
  });
});
