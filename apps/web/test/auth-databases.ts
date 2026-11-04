import { createMigratedDatabase, databaseUrl, dropDatabase } from "@stargrep/db/local-database";
import * as Effect from "effect/Effect";

const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";

export const authDatabases = {
  AUTH_LOCAL_DATABASE: `stargrep_web_local_${process.pid}`,
  AUTH_PROD_DATABASE: `stargrep_web_prod_${process.pid}`,
  AUTH_PREVIEW_DATABASE: `stargrep_web_preview_${process.pid}`,
};

export const authHyperdrives = Object.fromEntries(
  Object.entries(authDatabases).map(([binding, name]) => [binding, databaseUrl(adminUrl, name)]),
);

export default async function setup() {
  const names = Object.values(authDatabases);
  await Effect.runPromise(Effect.forEach(names, (name) => createMigratedDatabase(adminUrl, name), { discard: true }));
  return () => Effect.runPromise(Effect.forEach(names, (name) => dropDatabase(adminUrl, name), { discard: true }));
}
