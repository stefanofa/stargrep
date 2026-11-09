import { Curation, RepoKnowledge } from "@stargrep/core/knowledge";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// The nightly count, then the usage floor, which reads the counts it just wrote. A failed count skips the floor, which
// would read yesterday's counts.
export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  RepoKnowledge.count().pipe(
    Effect.tap(({ changed }) => Effect.logInfo("Knowledge count ran", { changed })),
    Effect.andThen(
      Curation.floor().pipe(
        Effect.flatMap(({ accepted }) => Effect.logInfo("Usage floor ran", { accepted })),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError("Usage floor failed", { cause }),
        ),
      ),
    ),
    Effect.provide(runtime),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Knowledge count failed", { cause }),
    ),
  );
