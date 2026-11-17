import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type { UserId } from "../auth-schema.ts";
import type { DbQueryFailed } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { monthlyPicks } from "../schema.ts";

export interface Queries {
  readonly optedIn: (userId: UserId) => Effect.Effect<boolean, DbQueryFailed>;
  // Whether the row changed, so a repeated opt-in or opt-out counts once.
  readonly set: (userId: UserId, optedIn: boolean) => Effect.Effect<boolean, DbQueryFailed>;
}

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  return {
    optedIn: (userId) =>
      run("monthlyPicks.optedIn", (db) =>
        db.select({ userId: monthlyPicks.userId }).from(monthlyPicks).where(eq(monthlyPicks.userId, userId)),
      ).pipe(Effect.map((rows) => rows.length > 0)),
    set: (userId, optedIn) =>
      run("monthlyPicks.set", (db) =>
        optedIn
          ? db.insert(monthlyPicks).values({ userId }).onConflictDoNothing().returning({ userId: monthlyPicks.userId })
          : db.delete(monthlyPicks).where(eq(monthlyPicks.userId, userId)).returning({ userId: monthlyPicks.userId }),
      ).pipe(Effect.map((rows) => rows.length > 0)),
  } satisfies Queries;
});
