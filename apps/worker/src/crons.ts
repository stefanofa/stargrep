import * as Cloudflare from "@alchemy.run/cloudflare";
import { IconQueue } from "@stargrep/core/icons";
import type { EnrichQueue } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as EnrichSweep from "./jobs/enrich-sweep.ts";
import { startIconBackfill } from "./queues.ts";

// The first retry delay is 10 minutes, so a repo goes out again within 10 minutes of its backoff ending.
const enrichSweepSchedule = "*/10 * * * *";
// The backfill walks every repo whose icon was never checked or is due its 30-day refresh, a page per message.
const iconBackfillSchedule = "17 4 * * *";

export const scheduleAll = <E>(
  runtime: Layer.Layer<Db.Db | EnrichQueue.EnrichQueue | IconQueue.IconQueue, E, RuntimeContext>,
) =>
  Effect.all([
    Cloudflare.Workers.cron(enrichSweepSchedule, () => EnrichSweep.run(runtime)),
    Cloudflare.Workers.cron(iconBackfillSchedule, () =>
      IconQueue.IconQueue.use((queue) => queue.send([startIconBackfill])).pipe(Effect.provide(runtime)),
    ),
  ]);
