import { curated } from "@stargrep/api/public-config";
import * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// Lists the people the rule and the curated logins pick, and reads the stars of each one that synced since.
export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const refreshed = yield* db.people.refresh(curated, yield* DateTime.now);
    yield* Effect.logInfo("People refreshed", refreshed);
  }).pipe(
    Effect.provide(runtime),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("People refresh failed", { cause }),
    ),
  );
