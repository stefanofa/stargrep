import { createMigratedDatabase, dropDatabase } from "@stargrep/db/local-database";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const name = Schema.decodeUnknownSync(Schema.String)(project.config.provide.databaseName);
  const admin = Schema.decodeUnknownSync(Schema.String)(project.config.provide.adminUrl);
  await Effect.runPromise(createMigratedDatabase(admin, name));
  return () => Effect.runPromise(dropDatabase(admin, name));
}
