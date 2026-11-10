import { database, sql } from "./stubs.ts";

export const write = database.query(`update repos set
  summary = 'A summary', kind = 'cli' where id = 1`);
export const interpolated = sql`update repos set kind = ${"cli"} where id = 1`;
