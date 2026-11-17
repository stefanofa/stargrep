import { eq, sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { DbQueryFailed } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded } from "../rows.ts";
import { starImportOwner } from "../schema.ts";

export interface Queries {
  // Whether owner now holds the import: it held it already, or nobody did, or the holder's heartbeat is older than
  // stale. Both times are the database's, so drivers whose clocks disagree still agree on the age.
  readonly claim: (input: {
    readonly owner: string;
    readonly stale: Duration.Duration;
  }) => Effect.Effect<boolean, DbQueryFailed>;
  // Whether owner still holds the import.
  readonly heartbeat: (owner: string) => Effect.Effect<boolean, DbQueryFailed>;
  readonly release: (owner: string) => Effect.Effect<void, DbQueryFailed>;
}

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  return {
    claim: ({ owner, stale }) =>
      run("starImports.claim", (db) =>
        db
          .insert(starImportOwner)
          .values({ owner, heartbeatAt: sql`now()` })
          .onConflictDoUpdate({
            target: starImportOwner.singleton,
            set: { owner: excluded(starImportOwner.owner), heartbeatAt: excluded(starImportOwner.heartbeatAt) },
            setWhere: sql`${starImportOwner.owner} = ${excluded(starImportOwner.owner)} or ${starImportOwner.heartbeatAt} < now() - ${Duration.toMillis(stale)} * interval '1 millisecond'`,
          })
          .returning({ owner: starImportOwner.owner }),
      ).pipe(Effect.map((rows) => rows.length > 0)),
    heartbeat: (owner) =>
      run("starImports.heartbeat", (db) =>
        db
          .update(starImportOwner)
          .set({ heartbeatAt: sql`now()` })
          .where(eq(starImportOwner.owner, owner))
          .returning({ owner: starImportOwner.owner }),
      ).pipe(Effect.map((rows) => rows.length > 0)),
    release: (owner) =>
      run("starImports.release", (db) => db.delete(starImportOwner).where(eq(starImportOwner.owner, owner))).pipe(
        Effect.asVoid,
      ),
  } satisfies Queries;
});
