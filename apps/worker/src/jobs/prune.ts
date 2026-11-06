import { SyncRequests } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  SyncRequests.prune().pipe(
    Effect.provide(runtime),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Prune failed", { cause }),
    ),
  );
