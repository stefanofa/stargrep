import { db, repos } from "./stubs.ts";

export const read = db.select({ kind: repos.kind }).from(repos);
