import type * as Embeddings from "@stargrep/ai/embeddings";
import { MetadataEmbeddings } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// An embedding is saved only while it is still due, so a run cut off here loses nothing and the next one goes on.
const timeout = Duration.minutes(5);

export const run = <E, R>(runtime: Layer.Layer<Db.Db | Embeddings.Embeddings, E, R>) =>
  MetadataEmbeddings.sweep().pipe(
    Effect.timeout(timeout),
    Effect.provide(runtime),
    Effect.flatMap((result) => Effect.logInfo("Metadata sweep ran", result)),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Metadata sweep failed", { cause }),
    ),
  );
