import type * as Embeddings from "@stargrep/ai/embeddings";
import type { EnrichQueue } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as EnrichSweep from "./enrich-sweep.ts";
import * as MetadataSweep from "./metadata-sweep.ts";
import * as ProjectionSweep from "./projection-sweep.ts";

// Each sweep logs its own failures and never fails, so one failing never stops the others.
export const run = <E, R>(runtime: Layer.Layer<Db.Db | EnrichQueue.EnrichQueue | Embeddings.Embeddings, E, R>) =>
  Effect.all([EnrichSweep.run(runtime), MetadataSweep.run(runtime), ProjectionSweep.run(runtime)], {
    concurrency: "unbounded",
    discard: true,
  });
