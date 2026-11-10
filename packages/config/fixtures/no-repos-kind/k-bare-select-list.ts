import { database } from "./stubs.ts";

export const read = database.query("select id::float8 as id, kind from repos where id = any($1)", [[1]]);
export const only = database.query("select kind from repos");
export const derived = database.query("select (kinds)[1]::text as kind from repos");
