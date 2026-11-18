import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type { DbQueryFailed } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded } from "../rows.ts";
import { iconBackfill } from "../schema.ts";

export interface Queries {
  // The position a chain should run from: the running chain's, or 0 when none runs, which starts one there.
  readonly start: Effect.Effect<number, DbQueryFailed>;
  // Moves the chain from one page's position to the next, null when that page was the last. False when the chain
  // stands elsewhere or has finished, because another copy of the page or another chain moved it first. With no row,
  // which only a database that never started a chain has, the page takes the chain.
  readonly advance: (move: {
    readonly from: number;
    readonly to: number | null;
  }) => Effect.Effect<boolean, DbQueryFailed>;
}

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  return {
    start: run("iconBackfill.start", (db) =>
      db
        .insert(iconBackfill)
        .values({ after: 0 })
        .onConflictDoUpdate({ target: iconBackfill.singleton, set: { after: sql`coalesce(${iconBackfill.after}, 0)` } })
        .returning({ after: iconBackfill.after }),
    ).pipe(Effect.map((rows) => rows[0]?.after ?? 0)),
    advance: ({ from, to }) =>
      run("iconBackfill.advance", (db) =>
        db
          .insert(iconBackfill)
          .values({ after: to })
          .onConflictDoUpdate({
            target: iconBackfill.singleton,
            set: { after: excluded(iconBackfill.after) },
            setWhere: sql`${iconBackfill.after} = ${from}`,
          })
          .returning({ singleton: iconBackfill.singleton }),
      ).pipe(Effect.map((rows) => rows.length > 0)),
  } satisfies Queries;
});
