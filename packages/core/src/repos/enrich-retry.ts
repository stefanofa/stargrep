import * as Db from "@stargrep/db";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EnrichQueue from "./enrich-queue.ts";

// After its nth failed enrichment a repo waits retryDelays[n - 1] before the sweep sends it again.
// A repo that fails once more than there are delays counts as failed, and only a later sync sends it again.
export const retryDelays = [Duration.minutes(10), Duration.hours(1)] as const;

export const maxFailures = retryDelays.length + 1;

export const sweepBatch = 100;

export interface FailureRecord {
  readonly enrichFailures: number;
  readonly enrichFailedAt: DateTime.Utc | null;
}

// A repo under the cap whose last failure is newer than its delay is waiting for the sweep. Any message that
// reaches it sooner is a copy of an attempt already counted, such as a queue retry or a second sweep send.
export const inBackoff = ({ enrichFailures, enrichFailedAt }: FailureRecord, now: DateTime.Utc) => {
  const delay = retryDelays[enrichFailures - 1];
  return (
    delay !== undefined &&
    enrichFailedAt !== null &&
    DateTime.isGreaterThan(enrichFailedAt, DateTime.subtractDuration(now, delay))
  );
};

export const sweep = Effect.fn("EnrichRetry.sweep")(function* () {
  const db = yield* Db.Db;
  const queue = yield* EnrichQueue.EnrichQueue;
  const now = yield* DateTime.now;
  const ids = yield* db.repos.sweepable({
    cutoffs: retryDelays.map((delay) => DateTime.subtractDuration(now, delay)),
    limit: sweepBatch,
  });
  if (Arr.isReadonlyArrayNonEmpty(ids)) yield* queue.send(ids.map((repoId) => ({ repoId })));
  return { enqueued: ids.length };
});
