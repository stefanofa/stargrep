import { database } from "./stubs.ts";

export const read = database.query("select r.kind from repos r where r.id = $1", [1]);
export const qualified = database.query("select repos.kind from repos");
