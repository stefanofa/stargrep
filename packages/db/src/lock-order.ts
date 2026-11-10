import { type SQL, sql } from "drizzle-orm";

// Every multi-row writer of repos locks its rows in ID order, so two of them, or one and the projection sweep, never
// wait on each other in a cycle. An update filters on lockedRepoIds, since without that subquery Postgres may pick a
// bitmap heap scan and lock the rows in heap order. An insert, or an update joined to rows the caller supplies, takes
// them inIdOrder.
export const lockedRepoIds = (ids: ReadonlyArray<number>): SQL =>
  sql`select id from repos where id = any(${sql.param([...ids].sort((a, b) => a - b))}::bigint[]) order by id for no key update`;

export const inIdOrder = <A extends { readonly id: number }>(rows: ReadonlyArray<A>): Array<A> =>
  [...rows].sort((a, b) => a.id - b.id);
