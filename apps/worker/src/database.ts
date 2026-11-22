import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import { migrationsFolder } from "@stargrep/db/migrations";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
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

// A 53-bit hash of a string, cyrb53, as 14 hex digits.
const hash = (text: string) => {
  let [h1, h2] = [0xdeadbeef, 0x41c6ce57];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

// Binding the migrations redeploys a Worker whenever one changes. Cloudflare caps a text binding at 5.1 kB, which every
// migration's hash together outgrew, so the binding holds their count, the newest one's name, and a hash of them all.
export const migrationsDigest = (hashes: Readonly<Record<string, string>>) => {
  const names = Object.keys(hashes).sort();
  return `${names.length}:${names.at(-1) ?? ""}:${hash(names.map((name) => `${name}=${hashes[name]}`).join("\n"))}`;
};

export const DatabaseMigrations = Effect.gen(function* () {
  return (yield* Alchemy.ALCHEMY_DEV) ? "local" : Output.map((yield* StageBranch).migrationsHashes, migrationsDigest);
});

export const Database = Effect.gen(function* () {
  const origin = (yield* Alchemy.ALCHEMY_DEV) ? localPostgres : (yield* StageBranch).origin;
  return yield* Cloudflare.Hyperdrive.Connection("Database", {
    origin,
    dev: localPostgres,
    caching: { disabled: true },
  });
});
