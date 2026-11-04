import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { AiRequestFailed } from "@stargrep/ai/errors";
import { EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import { DbQueryFailed } from "@stargrep/db/errors";
import { TokenBudgetExhausted } from "@stargrep/github/errors";
import { type GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import * as EnrichRepoConsumer from "../src/consumers/enrich-repo.ts";
import * as Settle from "../src/consumers/settle.ts";
import * as SyncStarsConsumer from "../src/consumers/sync-stars.ts";

const report = { listed: 1, added: 1, unchanged: 0, unstarred: 0, enqueued: 1, shifted: false };
const repoId = Schema.decodeUnknownSync(RepoId);
const inMillis = (millis: number) => Effect.map(Clock.currentTimeMillis, (now) => now + millis);

const recordingQueues = () => {
  const later: Array<{ readonly body: unknown; readonly delaySeconds: number }> = [];
  const deadLetters: Array<unknown> = [];
  const queues: Settle.Queues = {
    name: "test",
    sendLater: (body, delaySeconds) => Effect.sync(() => void later.push({ body, delaySeconds })),
    deadLetter: (body) => Effect.sync(() => void deadLetters.push(body)),
  };
  return { later, deadLetters, queues };
};

const batchOf = (queue: string, bodies: ReadonlyArray<unknown>) =>
  createMessageBatch(
    queue,
    bodies.map((body, index) => ({ id: `m${index}`, timestamp: 0, attempts: 1, body })),
  );

const run = async <E>(effect: Effect.Effect<void, E>, batch: MessageBatch) => {
  const ctx = createExecutionContext();
  await Effect.runPromise(effect);
  return getQueueResult(batch, ctx);
};

const syncing = (sync: StarSync.StarSync["Service"]["sync"]) =>
  Layer.mock(StarSync.StarSync, { sync, syncLogin: () => Effect.succeed(report) });

describe("sync-stars consumer", () => {
  it("dead-letters a body it cannot decode at once and acks it", async () => {
    const { queues, deadLetters, later } = recordingQueues();
    const batch = batchOf("sync-stars", ["not a request", { accountId: "1", mode: "full" }]);
    const result = await run(
      SyncStarsConsumer.processBatch(queues, batch.messages).pipe(Effect.provide(syncing(() => Effect.die("unused")))),
      batch,
    );
    expect(deadLetters).toEqual(["not a request", { accountId: "1", mode: "full" }]);
    expect(later).toEqual([]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("acks a synced account and retries one whose sync failed", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [
      { accountId: 1, mode: "full" },
      { accountId: 2, mode: "incremental" },
    ]);
    const sync: StarSync.StarSync["Service"]["sync"] = (request) =>
      request.accountId === (2 as GitHubAccountId)
        ? Effect.fail(new DbQueryFailed({ operation: "stars.upsert", reason: "transport", sqlState: null }))
        : Effect.succeed(report);
    const result = await run(
      SyncStarsConsumer.processBatch(queues, batch.messages).pipe(Effect.provide(syncing(sync))),
      batch,
    );
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([{ msgId: "m1" }]);
    expect(deadLetters).toEqual([]);
  });

  it("sends a sync that ran out of GitHub budget again after the reset, without spending a retry", async () => {
    const { queues, later } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental" }]);
    const result = await run(
      SyncStarsConsumer.processBatch(queues, batch.messages).pipe(
        Effect.provide(
          Layer.mock(StarSync.StarSync, {
            syncLogin: () =>
              Effect.flatMap(inMillis(600_000), (resetAt) =>
                Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt })),
              ),
          }),
        ),
      ),
      batch,
    );
    expect(later).toHaveLength(1);
    expect(later[0]?.body).toEqual({ login: "octocat", mode: "incremental" });
    expect(later[0]?.delaySeconds).toBeGreaterThanOrEqual(600);
    expect(later[0]?.delaySeconds).toBeLessThanOrEqual(606);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("enrich-repo consumer", () => {
  const enriching = (outcomes: (ids: ReadonlyArray<RepoId>) => ReadonlyArray<EnrichRepo.Enrichment>) =>
    Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: (ids, summaries) => {
        expect(summaries).toBe("direct");
        return Effect.succeed(outcomes(ids));
      },
    });

  it("acks enriched repos, retries a failed one, and dead-letters a malformed body in the same batch", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("enrich-repo", [{ repoId: 1 }, { repoId: 2 }, { repo: "x" }, { repoId: 1 }]);
    const asked: Array<ReadonlyArray<RepoId>> = [];
    const layer = enriching((ids) => {
      asked.push(ids);
      return [
        EnrichRepo.Enrichment.Unchanged({ id: repoId(1) }),
        EnrichRepo.Enrichment.Failed({
          id: repoId(2),
          error: new AiRequestFailed({ operation: "generate", model: "test", detail: "500" }),
        }),
        EnrichRepo.Enrichment.Unchanged({ id: repoId(1) }),
      ];
    });
    const result = await run(
      EnrichRepoConsumer.processBatch(queues, batch.messages).pipe(Effect.provide(layer)),
      batch,
    );
    expect(asked).toEqual([[1, 2, 1]]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m2", "m3"]);
    expect(result.retryMessages).toEqual([{ msgId: "m1" }]);
    expect(deadLetters).toEqual([{ repo: "x" }]);
  });

  it("defers the whole batch when GitHub's budget stops the plan", async () => {
    const { queues, later } = recordingQueues();
    const batch = batchOf("enrich-repo", [{ repoId: 3 }, { repoId: 4 }]);
    const layer = Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: () =>
        Effect.flatMap(inMillis(60_000), (resetAt) =>
          Effect.fail(new TokenBudgetExhausted({ resource: "graphql", resetAt })),
        ),
    });
    const result = await run(
      EnrichRepoConsumer.processBatch(queues, batch.messages).pipe(Effect.provide(layer)),
      batch,
    );
    expect(later.map((sent) => sent.body)).toEqual([{ repoId: 3 }, { repoId: 4 }]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("dead letters", () => {
  it("logs only the type of a body it cannot decode", async () => {
    const logs: Array<unknown> = [];
    const batch = batchOf("sync-stars-dead-letters", ["secret-looking payload", { login: "octocat", mode: "full" }]);
    await Effect.runPromise(
      Settle.logDeadLetters(
        "sync-stars",
        SyncStarsConsumer.describe,
      )(Stream.fromIterable(batch.messages)).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
      ),
    );
    expect(JSON.stringify(logs)).not.toContain("secret-looking payload");
    expect(logs).toEqual([
      ["Dead letter", { queue: "sync-stars", messageId: "m0", attempts: 1, bodyType: "string" }],
      ["Dead letter", { queue: "sync-stars", messageId: "m1", attempts: 1, login: "octocat", mode: "full" }],
    ]);
  });
});
