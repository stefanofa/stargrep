import { RepoKnowledge } from "@stargrep/core/knowledge";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export const run = <E, R>(runtime: Layer.Layer<Db.Db, E, R>) =>
  RepoKnowledge.count().pipe(
    Effect.provide(runtime),
    Effect.flatMap(({ changed }) => Effect.logInfo("Knowledge count ran", { changed })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Knowledge count failed", { cause }),
    ),
  );
