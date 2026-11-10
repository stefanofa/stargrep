import { database, db, repos, sql } from "./stubs.ts";

export const atoms = db.select({ kinds: repos.kinds }).from(repos);
export const primary = sql`(${repos.kinds})[1]::text`;
export const read = database.query("select r.kinds::text[] as kinds from repos r");
export const write = database.query("update repos set kinds = '{cli}' where id = 1");
export const insert = database.query("insert into repos (id, owner, name, kinds) values (1, 'o', 'n', '{cli}')");
