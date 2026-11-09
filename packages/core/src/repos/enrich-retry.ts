import * as Db from "@stargrep/db";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EnrichQueue from "./enrich-queue.ts";

// After its nth counted failure a repo waits retryDelays[n - 1] before the sweep sends it again. One more failure
// than there are delays reaches Db.enrichFailureCap, and only a later sync sends the repo again.
export const retryDelays = [Duration.minutes(10), Duration.hours(1)] as const;

export const sweepBatch = 100;

// How long an attempt holds a repo before its paid summary call, so a second message, the sweep, or another consumer
// skips it. It outlasts the queue consumer's 10-minute deadline, and capture gives it back with the answer, so a repo
// whose attempt died becomes due again once it runs out.
export const attemptLease = Duration.minutes(15);

// The lease for an attempt that asks about this many repos. A provider batch of two or more prompts can wait as long
// as its timeout, 24 hours on the Gateway, so the lease covers that wait and the capture after it.
export const leaseFor = (batchTimeout: Option.Option<Duration.Duration>, prompts: number): Duration.Duration =>
  Option.match(batchTimeout, {
    onNone: () => attemptLease,
    onSome: (timeout) => (prompts < 2 ? attemptLease : Duration.sum(timeout, attemptLease)),
  });

export const inBackoff = (repo: Pick<Db.StoredRepo, "enrichRetryAt">, now: DateTime.Utc) =>
  repo.enrichRetryAt !== null && DateTime.isGreaterThan(repo.enrichRetryAt, now);

export const sweep = Effect.fn("EnrichRetry.sweep")(function* () {
  const db = yield* Db.Db;
  const queue = yield* EnrichQueue.EnrichQueue;
  const ids = yield* db.repos.sweepable({ now: yield* DateTime.now, limit: sweepBatch });
  if (Arr.isReadonlyArrayNonEmpty(ids)) yield* queue.send(ids.map((repoId) => ({ repoId })));
  return { enqueued: ids.length };
});
