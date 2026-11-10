import { database } from "./stubs.ts";

export const write = database.query(
  `insert into repos (id, owner, name, summary, kind)
   values ($1, 'probe', 'repo', 'A summary', 'cli')`,
  [1],
);
