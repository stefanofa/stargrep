import * as Db from "@stargrep/db";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EnrichQueue from "./enrich-queue.ts";

// After its nth counted failure a repo waits retryDelays[n - 1] before the sweep sends it again. One more failure
// than there are delays reaches Db.enrichFailureCap, and only a later sync sends the repo again.
export const retryDelays = [Duration.minutes(10), Duration.hours(1)] as const;

export const sweepBatch = 100;

export const inBackoff = (repo: Pick<Db.StoredRepo, "enrichRetryAt">, now: DateTime.Utc) =>
  repo.enrichRetryAt !== null && DateTime.isGreaterThan(repo.enrichRetryAt, now);

export const sweep = Effect.fn("EnrichRetry.sweep")(function* () {
  const db = yield* Db.Db;
  const queue = yield* EnrichQueue.EnrichQueue;
  const ids = yield* db.repos.sweepable({ now: yield* DateTime.now, limit: sweepBatch });
  if (Arr.isReadonlyArrayNonEmpty(ids)) yield* queue.send(ids.map((repoId) => ({ repoId })));
  return { enqueued: ids.length };
});
