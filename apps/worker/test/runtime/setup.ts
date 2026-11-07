import { createMigratedDatabase, dropDatabase } from "@stargrep/db/local-database";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const name = Schema.decodeUnknownSync(Schema.String)(project.config.provide.databaseName);
  const admin = "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
  await Effect.runPromise(createMigratedDatabase(admin, name));
  return () => Effect.runPromise(dropDatabase(admin, name));
}
