import { accounts, db, repos } from "./stubs.ts";

export const write = db.insert(repos, "id", "owner", "name", "nodeId").values({ id: 1, owner: "o", name: "n" });
export const read = db.select({ id: repos.id }).from(repos);
export const other = db.insert(accounts).values({ id: 1 });
