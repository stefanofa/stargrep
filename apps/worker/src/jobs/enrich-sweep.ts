import { type EnrichQueue, EnrichRetry } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// A sweep still running at the next fire would send the same repos twice.
const timeout = Duration.minutes(5);

export const run = <E, R>(runtime: Layer.Layer<Db.Db | EnrichQueue.EnrichQueue, E, R>) =>
  EnrichRetry.sweep().pipe(
    Effect.timeout(timeout),
    Effect.provide(runtime),
    Effect.flatMap(({ enqueued }) => Effect.logInfo("Enrich sweep ran", { enqueued })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Enrich sweep failed", { cause }),
    ),
  );
