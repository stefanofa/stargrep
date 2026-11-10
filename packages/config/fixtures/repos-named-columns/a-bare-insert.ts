import { db, repos } from "./stubs.ts";

export const write = db.insert(repos).values({ id: 1, owner: "o", name: "n" });
