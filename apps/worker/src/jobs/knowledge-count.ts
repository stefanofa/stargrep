import { Curation, RepoKnowledge } from "@stargrep/core/knowledge";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

const logged = <A, E, R>(failed: string, step: Effect.Effect<A, E, R>) =>
  step.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError(failed, { cause }),
    ),
  );

// The nightly count, then the usage floor, which reads the counts it just wrote. A failed count skips the floor, which
// would read yesterday's counts. The closed values' count reads nothing the other two write, so it runs either way.
export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  Effect.andThen(
    logged(
      "Knowledge count failed",
      RepoKnowledge.count().pipe(
        Effect.tap(({ changed }) => Effect.logInfo("Knowledge count ran", { changed })),
        Effect.andThen(
          logged(
            "Usage floor failed",
            Curation.floor().pipe(Effect.flatMap(({ accepted }) => Effect.logInfo("Usage floor ran", { accepted }))),
          ),
        ),
      ),
    ),
    logged(
      "Atom count failed",
      RepoKnowledge.countAtoms().pipe(Effect.flatMap(({ changed }) => Effect.logInfo("Atom count ran", { changed }))),
    ),
  ).pipe(Effect.provide(runtime), (job) => logged("Knowledge count failed", job));
