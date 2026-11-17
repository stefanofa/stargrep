import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Embeddings from "@stargrep/ai/embeddings";
import { IconQueue } from "@stargrep/core/icons";
import type { EnrichQueue } from "@stargrep/core/repos";
import type * as Db from "@stargrep/db";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Observe } from "./analytics.ts";
import * as KnowledgeCount from "./jobs/knowledge-count.ts";
import * as Prune from "./jobs/prune.ts";
import * as Sweeps from "./jobs/sweeps.ts";
import { startIconBackfill } from "./queues.ts";

// The enrichment sweep, the metadata sweep, and the projection sweep. The first retry delay is 10 minutes, so a repo goes
// out again within 10 minutes of its backoff ending, a repo due a metadata embedding gets it within 10 minutes of the
// line having room, and a stale repo_facets row is projected within 10 minutes. All three run from this one handler on
// the same minutes. Neon suspends a compute after 5 idle minutes, and a query at any other minute would
// leave it no idle window, so the database would never scale to zero.
const sweepSchedule = "*/10 * * * *";
// The backfill walks every repo whose icon was never checked or is due its 30-day refresh, a page per message.
const iconBackfillSchedule = "20 4 * * *";
// On a sweep minute, so it adds no database wake-up of its own.
const pruneSchedule = "40 * * * *";
// Listing reads the nightly count. It runs on a sweep minute, so it wakes the database no extra time.
const knowledgeCountSchedule = "30 3 * * *";

export const scheduleAll = <E>(
  runtime: Layer.Layer<
    Db.Db | EnrichQueue.EnrichQueue | IconQueue.IconQueue | Embeddings.Embeddings,
    E,
    RuntimeContext
  >,
  observe: Observe,
) =>
  Effect.all([
    Cloudflare.Workers.cron(sweepSchedule, () => Sweeps.run(runtime).pipe(observe("Sweeps"))),
    Cloudflare.Workers.cron(iconBackfillSchedule, () =>
      IconQueue.IconQueue.use((queue) => queue.send([startIconBackfill])).pipe(
        Effect.provide(runtime),
        observe("Icon backfill"),
      ),
    ),
    Cloudflare.Workers.cron(pruneSchedule, () => Prune.run(runtime).pipe(observe("Prune"))),
    Cloudflare.Workers.cron(knowledgeCountSchedule, () => KnowledgeCount.run(runtime).pipe(observe("Knowledge count"))),
  ]);
