import { RepoKnowledge } from "@stargrep/core/knowledge";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// Projection is idempotent, so a run cut off here loses nothing: its rows stay stale for the next run.
const timeout = Duration.minutes(5);

export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  RepoKnowledge.reproject().pipe(
    Effect.timeout(timeout),
    Effect.provide(runtime),
    Effect.flatMap((result) => Effect.logInfo("Projection sweep ran", result)),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Projection sweep failed", { cause }),
    ),
  );
