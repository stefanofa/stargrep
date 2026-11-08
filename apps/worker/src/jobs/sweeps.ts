import type { EnrichQueue } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as EnrichSweep from "./enrich-sweep.ts";
import * as ProjectionSweep from "./projection-sweep.ts";

// Both sweeps log their own failures and never fail, so one failing never stops the other.
export const run = <E, R>(runtime: Layer.Layer<Db.Db | EnrichQueue.EnrichQueue, E, R>) =>
  Effect.all([EnrichSweep.run(runtime), ProjectionSweep.run(runtime)], { concurrency: "unbounded", discard: true });
