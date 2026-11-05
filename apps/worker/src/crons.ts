import * as Cloudflare from "@alchemy.run/cloudflare";
import type { EnrichQueue } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Layer from "effect/Layer";
import * as EnrichSweep from "./jobs/enrich-sweep.ts";

// The first retry delay is 10 minutes, so a repo goes out again within 10 minutes of its backoff ending.
const enrichSweepSchedule = "*/10 * * * *";

export const scheduleAll = <E>(runtime: Layer.Layer<Db.Db | EnrichQueue.EnrichQueue, E, RuntimeContext>) =>
  Cloudflare.Workers.cron(enrichSweepSchedule, () => EnrichSweep.run(runtime));
