import { db, repos } from "./stubs.ts";

export const read = db.select().from(repos).limit(1);
