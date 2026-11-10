import { repos, sql } from "./stubs.ts";

export const read = sql`select ${repos.kind} from ${repos}`;
