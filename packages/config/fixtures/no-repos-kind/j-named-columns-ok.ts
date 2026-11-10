import { db, getColumns, repos, Struct, text } from "./stubs.ts";

export const write = db.insert(repos, "id", "owner", "name", "nodeId").values({ id: 1, owner: "o", name: "n" });
export const read = db.select({ id: repos.id }).from(repos);
export const field = { kind: text("kind") };
export const columns = Struct.omit(getColumns(repos), ["kind"]);
