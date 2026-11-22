import * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// Reads every topic's repos and roles, then lists the topics that get a page, from synced stars and facets alone.
export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const refreshed = yield* db.topics.refresh();
    yield* Effect.logInfo("Topics refreshed", refreshed);
  }).pipe(
    Effect.provide(runtime),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Topics refresh failed", { cause }),
    ),
  );
