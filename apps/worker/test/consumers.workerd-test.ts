import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import {
  AiKeyMissing,
  AiModelNotFound,
  AiOutputInvalid,
  AiRequestFailed,
  AiTimeout,
  AiUnavailable,
} from "@stargrep/ai/errors";
import { FetchIcon, IconQueue, IconStore } from "@stargrep/core/icons";
import { BlobStore, EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { EmbeddingModelId, EmbeddingModelMismatch } from "@stargrep/db/embedding";
import { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { makeDb } from "@stargrep/db/testing";
import {
  GitHubRequestFailed,
  GitHubResponseInvalid,
  GitHubTokenMissing,
  NotFound,
  RateLimited,
  TokenBudgetExhausted,
  Unauthorized,
} from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { GitHubAccountId, Login, type RepoId, RepoName } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import * as EnrichRepoConsumer from "../src/consumers/enrich-repo.ts";
import * as FetchIconConsumer from "../src/consumers/fetch-icon.ts";
import * as Settle from "../src/consumers/settle.ts";
import * as SyncStarsConsumer from "../src/consumers/sync-stars.ts";
import * as EnrichSweep from "../src/jobs/enrich-sweep.ts";
import * as KnowledgeCount from "../src/jobs/knowledge-count.ts";
import * as ProjectionSweep from "../src/jobs/projection-sweep.ts";
import * as Sweeps from "../src/jobs/sweeps.ts";
import * as Layers from "../src/layers.ts";
import * as UserGate from "../src/user-gate.ts";
import {
  answering,
  batchOf,
  inMillis,
  recordingLine,
  recordingQueues,
  repoId,
  report,
  run,
  runtimeContext,
  sending,
  share,
  syncing,
} from "./consumers.fixture.ts";

describe("sync-stars consumer", () => {
  it("dead-letters every body it cannot decode at once and acks it", async () => {
    const { queues, deadLetters, later } = recordingQueues();
    const batch = batchOf("sync-stars", ["not a request", { accountId: "1", mode: "full" }]);
    const result = await syncing(Layer.mock(StarSync.StarSync, {}))(queues, batch);
    expect(deadLetters).toEqual(["not a request", { accountId: "1", mode: "full" }]);
    expect(later).toEqual([]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("acks a synced login and retries one whose database connection dropped", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [
      { login: "octocat", mode: "full" },
      { login: "hubot", mode: "incremental" },
    ]);
    const layer = Layer.mock(StarSync.StarSync, {
      syncLogin: (request) =>
        request.login === "hubot"
          ? Effect.fail(new DbQueryFailed({ operation: "stars.upsert", reason: "transport", sqlState: null }))
          : Effect.succeed(report),
    });
    const result = await syncing(layer)(queues, batch);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([{ msgId: "m1" }]);
    expect(deadLetters).toEqual([]);
  });

  it("reconciles a first delivery with what it reserved, from the requests the token gate counted", async () => {
    const { queues } = recordingQueues();
    const line = recordingLine();
    const batch = batchOf("sync-stars", [
      { login: "octocat", mode: "incremental", reserved: 2 },
      { login: "hubot", mode: "incremental", reserved: 9 },
      { login: "debugged", mode: "full" },
    ]);
    const result = await syncing(sending(7), line)(queues, batch);
    expect(line.adjusted.toSorted((a, b) => a.units - b.units)).toEqual([
      { line: "all", units: -2 },
      { line: "all", units: 5 },
      { line: "all", units: 7 },
    ]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1", "m2"]);
  });

  it("gives back what a failed first delivery did not use, and bills what it sent", async () => {
    const { queues } = recordingQueues();
    const line = recordingLine();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental", reserved: 9 }]);
    const dropped = Effect.fail(new DbQueryFailed({ operation: "stars.upsert", reason: "transport", sqlState: null }));
    const result = await syncing(sending(3, dropped), line)(queues, batch);
    expect(line.adjusted).toEqual([{ line: "all", units: -6 }]);
    expect(result.retryMessages).toEqual([{ msgId: "m0" }]);
  });

  it("bills every request a later delivery sends, because the first one settled the reservation", async () => {
    const { queues } = recordingQueues();
    const line = recordingLine();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental", reserved: 9 }], 2);
    await syncing(sending(3), line)(queues, batch);
    expect(line.adjusted).toEqual([{ line: "all", units: 3 }]);
  });

  it("acks a sync whose reconciliation fails to write, and logs it, so GitHub is not read again", async () => {
    const { queues } = recordingQueues();
    const logs: Array<unknown> = [];
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental", reserved: 2 }]);
    const result = await syncing(sending(7), recordingLine(true), logs)(queues, batch);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
    expect(logs).toContainEqual(["Could not reconcile a sync with the line", { reason: "transport" }]);
  });

  it("sends a deferred sync again without its reservation, which its first delivery already settled", async () => {
    const { queues, later } = recordingQueues();
    const requestedAt = Date.parse("2026-11-04T12:00:00Z");
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental", requestedAt, reserved: 9 }]);
    const exhausted = Effect.flatMap(inMillis(600_000), (resetAt) =>
      Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt })),
    );
    const line = recordingLine();
    await syncing(sending(2, exhausted), line)(queues, batch);
    expect(line.adjusted).toEqual([{ line: "all", units: -7 }]);
    expect(later.map((sent) => sent.body)).toEqual([{ login: "octocat", mode: "incremental", requestedAt }]);
  });

  it("sends a sync that ran out of GitHub budget again after the reset, as it arrived, without spending a retry", async () => {
    const { queues, later } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental", from: "debug" }]);
    const layer = Layer.mock(StarSync.StarSync, {
      syncLogin: () =>
        Effect.flatMap(inMillis(600_000), (resetAt) =>
          Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt })),
        ),
    });
    const result = await syncing(layer)(queues, batch);
    expect(later).toHaveLength(1);
    expect(later[0]?.body).toEqual({ login: "octocat", mode: "incremental", from: "debug" });
    expect(later[0]?.delaySeconds).toBeGreaterThanOrEqual(600);
    expect(later[0]?.delaySeconds).toBeLessThanOrEqual(606);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
  });

  const unusedDb = Layer.succeed(Db.Db, makeDb({}));

  it("dead-letters a sync on a stage with no GitHub token on its first attempt", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "full" }]);
    const syncs = StarSync.layer.pipe(
      Layer.provide(GitHub.layer),
      Layer.provide(unusedDb),
      Layer.provide(EnrichQueue.layerMemory().layer),
    );
    const ctx = createExecutionContext();
    await Effect.runPromise(
      Settle.processBatch(SyncStarsConsumer.pipeline(share, syncs), queues, batch.messages).pipe(
        Effect.provide(Layer.mergeAll(TokenGate.layerMissing, UserGate.layerServerOnly, unusedDb)),
      ),
    );
    const result = await getQueueResult(batch, ctx);
    expect(deadLetters).toEqual([{ login: "octocat", mode: "full" }]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("defers a sync that hits GitHub's secondary rate limit with quota left, instead of dead-lettering it", async () => {
    const { queues, later, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "full" }]);
    const github = GitHubFake.layer(() => ({
      status: 403,
      body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
      headers: GitHubFake.rateLimitHeaders(4900, 3600),
    }));
    const syncs = StarSync.layer.pipe(
      Layer.provide(GitHub.layer),
      Layer.provide(unusedDb),
      Layer.provide(EnrichQueue.layerMemory().layer),
    );
    const line = recordingLine();
    const ctx = createExecutionContext();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Settle.processBatch(SyncStarsConsumer.pipeline(share, syncs), queues, batch.messages),
        );
        yield* TestClock.adjust("3 minutes");
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(Layer.mergeAll(github.layer, UserGate.layerServerOnly, line.layer, TestClock.layer()))),
    );
    const result = await getQueueResult(batch, ctx);
    expect(deadLetters).toEqual([]);
    expect(later).toEqual([{ body: { login: "octocat", mode: "full" }, delaySeconds: 65 }]);
    expect(github.sent).toHaveLength(4);
    expect(line.adjusted).toEqual([{ line: "all", units: 4 }]);
    expect(result.explicitAcks).toEqual(["m0"]);
  });

  it("retries a message whose deferred send failed and logs the send error", async () => {
    const { queues } = recordingQueues(true);
    const logs: Array<unknown> = [];
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental" }]);
    const layer = Layer.mock(StarSync.StarSync, {
      syncLogin: () =>
        Effect.flatMap(inMillis(60_000), (resetAt) =>
          Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt })),
        ),
    });
    const retried: Array<QueueRetryOptions | undefined> = [];
    for (const message of batch.messages) {
      const retry = message.retry.bind(message);
      message.retry = (options) => {
        retried.push(options);
        retry(options);
      };
    }
    const ctx = createExecutionContext();
    await Effect.runPromise(
      Settle.processBatch(SyncStarsConsumer.pipeline(share, layer), queues, batch.messages).pipe(
        Effect.provide(
          Layer.mergeAll(
            answering,
            UserGate.layerServerOnly,
            unusedDb,
            Logger.layer([Logger.make(({ message }) => logs.push(message))]),
          ),
        ),
      ),
    );
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "m0" }]);
    expect(retried).toEqual([{ delaySeconds: expect.any(Number) }]);
    expect(retried[0]?.delaySeconds ?? 0).toBeGreaterThanOrEqual(60);
    expect(JSON.stringify(logs)).toContain('"sendError":"QueueSendFailed"');
  });

  it("retries a message whose dead-letter send failed and logs the send error", async () => {
    const { queues } = recordingQueues(true);
    const logs: Array<unknown> = [];
    const batch = batchOf("sync-stars", ["not a request"]);
    const retried: Array<QueueRetryOptions | undefined> = [];
    for (const message of batch.messages) {
      const retry = message.retry.bind(message);
      message.retry = (options) => {
        retried.push(options);
        retry(options);
      };
    }
    const ctx = createExecutionContext();
    await Effect.runPromise(
      Settle.processBatch(
        SyncStarsConsumer.pipeline(share, Layer.mock(StarSync.StarSync, {})),
        queues,
        batch.messages,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            answering,
            UserGate.layerServerOnly,
            unusedDb,
            Logger.layer([Logger.make(({ message }) => logs.push(message))]),
          ),
        ),
      ),
    );
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "m0" }]);
    expect(retried).toEqual([undefined]);
    expect(JSON.stringify(logs)).toContain('"sendError":"QueueSendFailed"');
  });
});

describe("fetch-icon consumer", () => {
  const iconRequest = IconQueue.IconRequest.make({
    repoId: repoId(7),
    owner: Schema.decodeSync(Login)("acme"),
    name: Schema.decodeSync(RepoName)("kit"),
    homepage: "https://kit.dev",
    iconFiles: [],
    readmeOid: null,
  });

  const attempt = (attempts: number) =>
    createMessageBatch("fetch-icon", [{ id: "m0", timestamp: 0, attempts, body: iconRequest }]);

  it("retries a host's 429 on the same message, so the attempt cap applies, and never re-sends it", async () => {
    const { queues, later, deadLetters } = recordingQueues();
    const layer = Layer.mock(FetchIcon.FetchIcon, {
      fetchIcon: () =>
        Effect.fail(
          new FetchIcon.IconFetchFailed({ host: "kit.dev", reason: "status", status: 429, retryAfterMillis: 65_000 }),
        ),
    });
    const retried: Array<QueueRetryOptions | undefined> = [];
    for (const attempts of [1, 2]) {
      const batch = attempt(attempts);
      for (const message of batch.messages) {
        const retry = message.retry.bind(message);
        message.retry = (options) => {
          retried.push(options);
          retry(options);
        };
      }
      const result = await run(
        Settle.processBatch(FetchIconConsumer.pipeline, queues, batch.messages).pipe(Effect.provide(layer)),
        batch,
      );
      expect(result.retryMessages).toEqual([{ msgId: "m0" }]);
      expect(result.explicitAcks).toEqual([]);
    }
    expect(retried).toEqual([{ delaySeconds: 70 }, { delaySeconds: 70 }]);
    expect(later).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  it("dispatches an icon request and a backfill page by tag", async () => {
    const { queues } = recordingQueues();
    const calls: Array<string> = [];
    const layer = Layer.mock(FetchIcon.FetchIcon, {
      fetchIcon: (request) =>
        Effect.sync(() => {
          calls.push(`icon ${request.repoId}`);
          return FetchIcon.IconOutcome.NoIcon({ id: request.repoId });
        }),
      backfill: (after) =>
        Effect.sync(() => {
          calls.push(`backfill ${after}`);
          return { queued: 0, next: null };
        }),
    });
    const batch = batchOf("fetch-icon", [iconRequest, IconQueue.BackfillIcons.make({ after: 42 }), { repoId: 7 }]);
    const result = await run(
      Settle.processBatch(FetchIconConsumer.pipeline, queues, batch.messages).pipe(Effect.provide(layer)),
      batch,
    );
    expect(calls.toSorted()).toEqual(["backfill 42", "icon 7"]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1", "m2"]);
  });
});

describe("enrich-repo consumer", () => {
  it("settles each message by its position in the batch", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("enrich-repo", [{ repoId: 1 }, { repoId: 2 }, { repo: "x" }, { repoId: 3 }, { repoId: 1 }]);
    const asked: Array<ReadonlyArray<RepoId>> = [];
    const layer = Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: (ids) => {
        asked.push(ids);
        return Effect.succeed([
          EnrichRepo.Enrichment.Summarized({ id: repoId(1), summary: { summary: "s", keywords: [] } }),
          EnrichRepo.Enrichment.Failed({
            id: repoId(2),
            error: new AiTimeout({ operation: "generate", model: "test", timeoutMillis: 60_000 }),
          }),
          EnrichRepo.Enrichment.Stale({ id: repoId(3) }),
          EnrichRepo.Enrichment.Unchanged({ id: repoId(1) }),
        ]);
      },
    });
    const result = await run(
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, batch.messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
      batch,
    );
    expect(asked).toEqual([[1, 2, 3, 1]]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m2", "m4"]);
    expect(result.retryMessages).toEqual([{ msgId: "m1" }, { msgId: "m3" }]);
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
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, batch.messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
      batch,
    );
    expect(later.map((sent) => sent.body)).toEqual([{ repoId: 3 }, { repoId: 4 }]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("enrich-repo consumer in chunks", () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  // Messages that log each ack and retry next to each run the fake enricher starts, in the order they happen.
  const loggedBatch = (bodies: ReadonlyArray<unknown>) => {
    const batch = batchOf("enrich-repo", bodies);
    const events: Array<string> = [];
    const messages = batch.messages.map(
      (message): Cloudflare.Queues.Message<unknown> => ({
        id: message.id,
        timestamp: message.timestamp,
        body: message.body,
        attempts: message.attempts,
        ack: () => {
          events.push(`ack ${message.id}`);
          message.ack();
        },
        retry: (options) => {
          events.push(`retry ${message.id}`);
          message.retry(options);
        },
      }),
    );
    return { batch, events, messages };
  };

  const enricher = (
    events: Array<string>,
    enrich: (
      ids: ReadonlyArray<RepoId>,
    ) => Effect.Effect<ReadonlyArray<EnrichRepo.Enrichment>, EnrichRepo.EnrichRepoAbort>,
  ) =>
    Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: (ids) =>
        Effect.sync(() => events.push(`run ${ids.join(",")}`)).pipe(
          Effect.andThen(enrich(ids)),
          Effect.onInterrupt(() => Effect.sync(() => events.push(`stopped ${ids.join(",")}`))),
        ),
    });

  const summarized = (ids: ReadonlyArray<RepoId>) =>
    ids.map((id) => EnrichRepo.Enrichment.Summarized({ id, summary: { summary: "s", keywords: [] } }));

  const names = (indexes: ReadonlyArray<number>) => indexes.map((index) => `m${index}`);
  const logged = (verb: string, indexes: ReadonlyArray<number>) => names(indexes).map((name) => `${verb} ${name}`);

  // The first chunk's messages run on the server's token, and the second chunk splits into a server group and a user
  // group whose model answers come in slowly and then fail.
  it("acks each chunk before the next starts, and acks an earlier group when a later group fails late", async () => {
    const bodies = range(1, 25).map((repoId) => (repoId >= 15 && repoId <= 20 ? { repoId, userId: "u1" } : { repoId }));
    const { queues } = recordingQueues();
    const { batch, events, messages } = loggedBatch(bodies);
    const layer = enricher(events, (asked) =>
      asked.includes(repoId(15))
        ? Effect.sleep("2 minutes").pipe(
            Effect.andThen(
              Effect.fail(new DbQueryFailed({ operation: "knowledge.capture", reason: "transport", sqlState: null })),
            ),
          )
        : Effect.as(Effect.sleep("1 minute"), summarized(asked)),
    );
    const result = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.timed(Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, messages)),
        );
        yield* TestClock.adjust("10 minutes");
        const [took] = yield* Fiber.join(fiber);
        expect(Duration.toMinutes(took)).toBe(5);
      }).pipe(Effect.provide(Layer.mergeAll(answering, UserGate.layerServerOnly, TestClock.layer()))),
      batch,
    );
    expect(events).toEqual([
      `run ${range(1, 10).join(",")}`,
      ...logged("ack", range(0, 9)),
      `run ${range(11, 14).join(",")}`,
      `run ${range(15, 20).join(",")}`,
      ...logged("ack", range(10, 13)),
      ...logged("retry", range(14, 19)),
      `run ${range(21, 25).join(",")}`,
      ...logged("ack", range(20, 24)),
    ]);
    expect(result.explicitAcks.toSorted()).toEqual(names([...range(0, 13), ...range(20, 24)]).toSorted());
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(names(range(14, 19)));
  });

  it("retries the chunk the deadline stops and every chunk after it, settling all by the deadline", async () => {
    const { queues } = recordingQueues();
    const { batch, events, messages } = loggedBatch(range(1, 40).map((repoId) => ({ repoId })));
    const layer = enricher(events, (asked) => Effect.as(Effect.sleep("4 minutes"), summarized(asked)));
    const result = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.timed(Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, messages)),
        );
        yield* TestClock.adjust("15 minutes");
        const [took] = yield* Fiber.join(fiber);
        expect(Duration.toMillis(took)).toBe(Duration.toMillis(EnrichRepoConsumer.chunks.deadline));
      }).pipe(Effect.provide(Layer.mergeAll(answering, UserGate.layerServerOnly, TestClock.layer()))),
      batch,
    );
    expect(events).toEqual([
      `run ${range(1, 10).join(",")}`,
      ...logged("ack", range(0, 9)),
      `run ${range(11, 20).join(",")}`,
      ...logged("ack", range(10, 19)),
      `run ${range(21, 30).join(",")}`,
      `stopped ${range(21, 30).join(",")}`,
      ...logged("retry", range(20, 39)),
    ]);
    expect(result.explicitAcks).toHaveLength(20);
    expect(result.retryMessages).toHaveLength(20);
  });

  it("defers a rate-limited gate's later chunks without running them, and keeps running other gates", async () => {
    const bodies = range(1, 30).map((repoId) => (repoId >= 16 && repoId <= 20 ? { repoId, userId: "u1" } : { repoId }));
    const { queues, later } = recordingQueues();
    const { batch, events, messages } = loggedBatch(bodies);
    const rateLimited = new RateLimited({ operation: "repo-facts", resource: "graphql", retryAfterMillis: 120_000 });
    const layer = enricher(events, (asked) =>
      asked.includes(repoId(16)) ? Effect.succeed(summarized(asked)) : Effect.fail(rateLimited),
    );
    const result = await run(
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
      batch,
    );
    expect(events.filter((event) => event.startsWith("run"))).toEqual([
      `run ${range(1, 10).join(",")}`,
      `run ${range(16, 20).join(",")}`,
    ]);
    expect(later.map((sent) => (sent.body as { readonly repoId: number }).repoId).toSorted((a, b) => a - b)).toEqual([
      ...range(1, 15),
      ...range(21, 30),
    ]);
    expect(new Set(later.map((sent) => sent.delaySeconds)).size).toBe(1);
    expect(result.explicitAcks).toHaveLength(30);
  });

  it("leaves an undecodable message for the batch's retry when a chunk dies, as before chunks", async () => {
    const { queues, deadLetters } = recordingQueues();
    const { events, messages } = loggedBatch([{ repo: "x" }, { repoId: 1 }]);
    const layer = enricher(events, () => Effect.die("lost the isolate"));
    const exit = await Effect.runPromiseExit(
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(events).toEqual(["run 1"]);
    expect(deadLetters).toEqual([]);
  });

  it("keeps a finished chunk's acks when a later chunk dies and the whole batch is retried", async () => {
    const { queues } = recordingQueues();
    const { batch, events, messages } = loggedBatch(range(1, 15).map((repoId) => ({ repoId })));
    const layer = enricher(events, (asked) =>
      asked.includes(repoId(11)) ? Effect.die("lost the isolate") : Effect.succeed(summarized(asked)),
    );
    const exit = await Effect.runPromiseExit(
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    // Alchemy retries every message of a batch whose handler failed, and a message's first ack or retry wins.
    for (const message of batch.messages) message.retry();
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks.toSorted()).toEqual(names(range(0, 9)).toSorted());
    expect(result.retryMessages.map((message) => message.msgId).toSorted()).toEqual(names(range(10, 14)).toSorted());
  });
});

describe("enrichment outcome table", () => {
  const summary = { summary: "s", keywords: [], kind: null };
  const timeout = new AiTimeout({ operation: "generate", model: "test", timeoutMillis: 60_000 });
  const request = new AiRequestFailed({ operation: "generate", model: "test", detail: "400" });
  const cases = {
    Unchanged: [[EnrichRepo.Enrichment.Unchanged({ id: repoId(1) }), "ack"]],
    NotFound: [[EnrichRepo.Enrichment.NotFound({ id: repoId(2) }), "ack"]],
    NoNodeId: [[EnrichRepo.Enrichment.NoNodeId({ id: repoId(3) }), "ack"]],
    Gone: [[EnrichRepo.Enrichment.Gone({ id: repoId(4) }), "ack"]],
    Backoff: [[EnrichRepo.Enrichment.Backoff({ id: repoId(10) }), "ack"]],
    Stale: [[EnrichRepo.Enrichment.Stale({ id: repoId(5) }), "retry"]],
    Failed: [
      [EnrichRepo.Enrichment.Failed({ id: repoId(6), error: timeout }), "retry"],
      [EnrichRepo.Enrichment.Failed({ id: repoId(7), error: request }), "dead-letter"],
    ],
    Summarized: [[EnrichRepo.Enrichment.Summarized({ id: repoId(8), summary }), "ack"]],
    Embedded: [[EnrichRepo.Enrichment.Embedded({ id: repoId(9), summary }), "ack"]],
  } satisfies {
    readonly [Tag in EnrichRepo.Enrichment["_tag"]]: ReadonlyArray<
      readonly [Extract<EnrichRepo.Enrichment, { readonly _tag: Tag }>, "ack" | "retry" | "dead-letter"]
    >;
  };

  // Gone, NoNodeId, and Backoff ack, because EnrichRepo counts a repo's own failure and the sweep owns the next try.
  it("settles every enrichment outcome the way its row says", async () => {
    const rows = Object.values(cases).flat();
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf(
      "enrich-repo",
      rows.map(([outcome]) => ({ repoId: outcome.id })),
    );
    const layer = Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: () => Effect.succeed(rows.map(([outcome]) => outcome)),
    });
    const result = await run(
      Settle.processBatch(EnrichRepoConsumer.pipeline(layer), queues, batch.messages).pipe(
        Effect.provide(Layer.merge(answering, UserGate.layerServerOnly)),
      ),
      batch,
    );
    const dead = new Set(deadLetters.map((body) => (body as { readonly repoId: number }).repoId));
    const retried = new Set(result.retryMessages.map((message) => message.msgId));
    const settled = rows.map(([outcome], index) => [
      outcome._tag,
      dead.has(outcome.id) ? "dead-letter" : retried.has(`m${index}`) ? "retry" : "ack",
    ]);
    expect(settled).toEqual(rows.map(([outcome, expected]) => [outcome._tag, expected]));
  });
});

describe("enrich sweep cron", () => {
  const sweepRuntime = (sweepable: Db.Db["Service"]["repos"]["sweepable"]) =>
    Layer.merge(Layer.succeed(Db.Db, makeDb({ repos: { sweepable } })), EnrichQueue.layerMemory().layer);
  const capture = () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
    const layer = Logger.layer([Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }))]);
    return { logs, layer };
  };

  it("logs a failed sweep and finishes", async () => {
    const { logs, layer } = capture();
    const down = sweepRuntime(() =>
      Effect.fail(new DbQueryFailed({ operation: "repos.sweepable", reason: "transport", sqlState: null })),
    );
    const exit = await Effect.runPromiseExit(EnrichSweep.run(down).pipe(Effect.provide(layer)));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.map((log) => [log.level, (log.message as ReadonlyArray<unknown>)[0]])).toEqual([
      ["Error", "Enrich sweep failed"],
    ]);
  });

  it("gives up a sweep that runs past five minutes and logs it", async () => {
    const { logs, layer } = capture();
    const stuck = sweepRuntime(() => Effect.never);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(EnrichSweep.run(stuck));
        yield* TestClock.adjust("5 minutes");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.map((log) => log.level)).toEqual(["Error"]);
  });

  it("keeps an interrupt as an interrupt instead of logging it as a failure", async () => {
    const { logs, layer } = capture();
    const stuck = sweepRuntime(() => Effect.never);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(EnrichSweep.run(stuck));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isSuccess(exit) && Exit.isFailure(exit.value) && Cause.hasInterruptsOnly(exit.value.cause)).toBe(true);
    expect(logs).toEqual([]);
  });
});

describe("knowledge crons", () => {
  const knowledgeRuntime = (knowledge: Partial<Db.Db["Service"]["knowledge"]>) =>
    Layer.succeed(Db.Db, makeDb({ knowledge }));
  const capture = () => {
    const logs: Array<{ readonly level: string; readonly message: ReadonlyArray<unknown> }> = [];
    const layer = Logger.layer([
      Logger.make(({ logLevel, message }) =>
        logs.push({ level: logLevel, message: message as ReadonlyArray<unknown> }),
      ),
    ]);
    return { logs, layer };
  };
  const down = new DbQueryFailed({ operation: "knowledge.stale", reason: "transport", sqlState: null });

  it("logs a sweep that found nothing stale", async () => {
    const { logs, layer } = capture();
    const idle = knowledgeRuntime({ stale: () => Effect.succeed([]) });
    await Effect.runPromise(ProjectionSweep.run(idle).pipe(Effect.provide(layer)));
    expect(logs).toEqual([
      { level: "Info", message: ["Projection sweep ran", { projected: 0, minted: 0, conflicts: 0 }] },
    ]);
  });

  it("logs a failed sweep and finishes", async () => {
    const { logs, layer } = capture();
    const exit = await Effect.runPromiseExit(
      ProjectionSweep.run(knowledgeRuntime({ stale: () => Effect.fail(down) })).pipe(Effect.provide(layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([["Error", "Projection sweep failed"]]);
  });

  it("gives up a sweep that runs past five minutes and logs it", async () => {
    const { logs, layer } = capture();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(ProjectionSweep.run(knowledgeRuntime({ stale: () => Effect.never })));
        yield* TestClock.adjust("5 minutes");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.map((log) => log.level)).toEqual(["Error"]);
  });

  it("runs both sweeps from the ten-minute handler, and a failing one never stops the other", async () => {
    const sweepsRuntime = (enrichFails: boolean, projectionFails: boolean) =>
      Layer.merge(
        Layer.succeed(
          Db.Db,
          makeDb({
            repos: {
              sweepable: () =>
                enrichFails
                  ? Effect.fail(
                      new DbQueryFailed({ operation: "repos.sweepable", reason: "transport", sqlState: null }),
                    )
                  : Effect.succeed([]),
            },
            knowledge: { stale: () => (projectionFails ? Effect.fail(down) : Effect.succeed([])) },
          }),
        ),
        EnrichQueue.layerMemory().layer,
      );
    const outcomes = [];
    for (const [enrichFails, projectionFails] of [
      [true, false],
      [false, true],
    ] as const) {
      const { logs, layer } = capture();
      const exit = await Effect.runPromiseExit(
        Sweeps.run(sweepsRuntime(enrichFails, projectionFails)).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      outcomes.push(logs.map((log) => `${log.level} ${String(log.message[0])}`).sort());
    }
    expect(outcomes).toEqual([
      ["Error Enrich sweep failed", "Info Projection sweep ran"],
      ["Error Projection sweep failed", "Info Enrich sweep ran"],
    ]);
  });

  it("logs the nightly count and the usage floor after it, skips the floor when the count fails, and counts atoms either way", async () => {
    const { logs, layer } = capture();
    const floorDown = new DbQueryFailed({ operation: "knowledge.floor", reason: "transport", sqlState: null });
    const atomsDown = new DbQueryFailed({ operation: "knowledge.countAtoms", reason: "timeout", sqlState: null });
    await Effect.runPromise(
      KnowledgeCount.run(
        knowledgeRuntime({ count: Effect.succeed(3), floor: Effect.succeed([]), countAtoms: Effect.succeed(22) }),
      ).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      KnowledgeCount.run(
        knowledgeRuntime({
          count: Effect.succeed(0),
          floor: Effect.fail(floorDown),
          countAtoms: Effect.fail(atomsDown),
        }),
      ).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      KnowledgeCount.run(knowledgeRuntime({ count: Effect.fail(down), countAtoms: Effect.succeed(0) })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([
      ["Info", "Knowledge count ran"],
      ["Info", "Usage floor ran"],
      ["Info", "Atom count ran"],
      ["Info", "Knowledge count ran"],
      ["Error", "Usage floor failed"],
      ["Error", "Atom count failed"],
      ["Error", "Knowledge count failed"],
      ["Info", "Atom count ran"],
    ]);
    expect(logs[0]?.message[1]).toEqual({ changed: 3 });
    expect(logs[1]?.message[1]).toEqual({ accepted: 0 });
    expect(logs[2]?.message[1]).toEqual({ changed: 22 });
  });
});

describe("settlement table", () => {
  const now = 1_000_000;
  const iconFetchFailed = (
    fields: Partial<{ reason: "status" | "timeout" | "transport" | "stale"; status: number; retryAfterMillis: number }>,
  ) =>
    new FetchIcon.IconFetchFailed({
      host: "raw.githubusercontent.com",
      reason: fields.reason ?? "status",
      status: fields.status ?? null,
      retryAfterMillis: fields.retryAfterMillis ?? null,
    });
  const model = Schema.decodeSync(EmbeddingModelId)("voyage/voyage-4");
  const endpoint = { operation: "list-stars", method: "GET", path: "/users/octocat/starred" } as const;
  const budgetExhausted = new TokenBudgetExhausted({ resource: "core", resetAt: now + 5_000 });
  const rateLimited = new RateLimited({ operation: "readme", resource: "core", retryAfterMillis: 90_000 });
  const cases = {
    TokenBudgetExhausted: [[budgetExhausted, "Defer"]],
    RateLimited: [[rateLimited, "Defer"]],
    Unauthorized: [[new Unauthorized({ operation: "owner" }), "DeadLetter"]],
    GitHubTokenMissing: [[new GitHubTokenMissing({ operation: "owner" }), "DeadLetter"]],
    AiKeyMissing: [[new AiKeyMissing({ operation: "generate", model: "m" }), "DeadLetter"]],
    AccountNotFound: [[new AccountNotFound({ accountId: Schema.decodeSync(GitHubAccountId)(7) }), "DeadLetter"]],
    EmbeddingModelMismatch: [[new EmbeddingModelMismatch({ expected: model, received: model }), "DeadLetter"]],
    NotFound: [[new NotFound({ operation: "owner", path: "/users/ghost" }), "DeadLetter"]],
    GitHubRequestFailed: [
      [new GitHubRequestFailed({ ...endpoint, status: null, reason: "transport" }), "Retry"],
      [new GitHubRequestFailed({ ...endpoint, status: null, reason: "timeout" }), "Retry"],
      [new GitHubRequestFailed({ ...endpoint, status: 503, reason: "status" }), "Retry"],
      [new GitHubRequestFailed({ ...endpoint, status: null, reason: "graphql-errors" }), "Retry"],
      [new GitHubRequestFailed({ ...endpoint, status: 403, reason: "status" }), "Retry"],
      [new GitHubRequestFailed({ ...endpoint, status: 422, reason: "status" }), "DeadLetter"],
    ],
    GitHubResponseInvalid: [
      [new GitHubResponseInvalid({ ...endpoint, reason: "unreadable-body" }), "Retry"],
      [new GitHubResponseInvalid({ ...endpoint, reason: "schema-mismatch" }), "DeadLetter"],
      [new GitHubResponseInvalid({ ...endpoint, reason: "invalid-link" }), "DeadLetter"],
    ],
    DbQueryFailed: [
      [new DbQueryFailed({ operation: "stars.upsert", reason: "transport", sqlState: null }), "Retry"],
      [new DbQueryFailed({ operation: "stars.upsert", reason: "timeout", sqlState: null }), "Retry"],
      [new DbQueryFailed({ operation: "stars.upsert", reason: "conflict", sqlState: "40P01" }), "Retry"],
      [new DbQueryFailed({ operation: "stars.upsert", reason: "conflict", sqlState: "40001" }), "Retry"],
      [new DbQueryFailed({ operation: "stars.upsert", reason: "constraint", sqlState: "23503" }), "Retry"],
      [new DbQueryFailed({ operation: "stars.upsert", reason: "query", sqlState: "42601" }), "DeadLetter"],
    ],
    DbRowInvalid: [[new DbRowInvalid({ operation: "repos.getMany", column: null }), "DeadLetter"]],
    EnrichQueueFailed: [[new EnrichQueue.EnrichQueueFailed({ messages: 3, cause: null }), "Retry"]],
    BlobStoreFailed: [[new BlobStore.BlobStoreFailed({ operation: "get", key: "readmes/x", cause: null }), "Retry"]],
    AiModelNotFound: [[new AiModelNotFound({ model: "m" }), "DeadLetter"]],
    AiOutputInvalid: [[new AiOutputInvalid({ operation: "generate", model: "m", detail: "d" }), "Retry"]],
    AnswerNotSaved: [
      [new EnrichRepo.AnswerNotSaved({ reason: "query", sqlState: "22P02", refused: true }), "DeadLetter"],
      [new EnrichRepo.AnswerNotSaved({ reason: "timeout", sqlState: null, refused: false }), "DeadLetter"],
    ],
    AiTimeout: [[new AiTimeout({ operation: "embed", model: "m", timeoutMillis: 30_000 }), "Retry"]],
    AiUnavailable: [[new AiUnavailable({ operation: "generate", model: "m", detail: "503" }), "Retry"]],
    AiRequestFailed: [[new AiRequestFailed({ operation: "generate", model: "m", detail: "400" }), "DeadLetter"]],
    IconFetchFailed: [
      [iconFetchFailed({ status: 429, retryAfterMillis: 60_000 }), "RetryLater"],
      [iconFetchFailed({ status: 503 }), "Retry"],
      [iconFetchFailed({ reason: "timeout" }), "Retry"],
      [iconFetchFailed({ reason: "transport" }), "Retry"],
      [iconFetchFailed({ reason: "stale" }), "Retry"],
    ],
    IconStoreFailed: [[new IconStore.IconStoreFailed({ operation: "put", key: "git/x.webp", cause: null }), "Retry"]],
    IconQueueFailed: [[new IconQueue.IconQueueFailed({ messages: 2, cause: null }), "Retry"]],
  } satisfies {
    readonly [Tag in Settle.Failure["_tag"]]: ReadonlyArray<
      readonly [Extract<Settle.Failure, { readonly _tag: Tag }>, Settle.Settlement["_tag"]]
    >;
  };

  it("settles every failure tag the way its row says", () => {
    const settled = Object.values(cases)
      .flat()
      .map(([error, expected]) => [error._tag, Settle.afterFailure(error, now)._tag, expected]);
    expect(settled.filter(([, actual, expected]) => actual !== expected)).toEqual([]);
  });

  it("defers an icon host's 429 by its retry-after, and never settles it as done", () => {
    expect(Settle.afterFailure(iconFetchFailed({ status: 429, retryAfterMillis: 120_000 }), now)).toEqual(
      Settle.Settlement.RetryLater({ error: "IconFetchFailed", until: now + 120_000 }),
    );
  });

  it("defers to the reset time or the retry-after interval", () => {
    expect(Settle.afterFailure(budgetExhausted, now)).toEqual(
      Settle.Settlement.Defer({ error: "TokenBudgetExhausted", until: now + 5_000 }),
    );
    expect(Settle.afterFailure(rateLimited, now)).toEqual(
      Settle.Settlement.Defer({ error: "RateLimited", until: now + 90_000 }),
    );
  });

  it("clamps a delay to between one second and twelve hours, with a margin past the reset", () => {
    expect(Settle.delaySeconds(now - 60_000, now)).toBe(1);
    expect(Settle.delaySeconds(now + 10_000, now)).toBe(15);
    expect(Settle.delaySeconds(now + 13 * 3_600_000, now)).toBe(12 * 3600);
  });
});

describe("production layers", () => {
  const fakeQueue = () => {
    const raw: Array<{ readonly body: unknown; readonly options: unknown }> = [];
    const sent: Array<unknown> = [];
    const batches: Array<number> = [];
    const client = {
      raw: Effect.succeed({
        send: async (body: unknown, options: unknown) => {
          raw.push({ body, options });
          return {};
        },
      }),
      send: (body: unknown) => Effect.sync(() => void sent.push(body)),
      sendBatch: (messages: ReadonlyArray<unknown>) => Effect.sync(() => void batches.push(messages.length)),
    } as unknown as Cloudflare.Queues.WriteQueueClient;
    return { raw, sent, batches, client };
  };

  it("sends a deferred message through the raw binding with its delay, and dead letters through send", async () => {
    const self = fakeQueue();
    const deadLetters = fakeQueue();
    await Effect.runPromise(
      Effect.gen(function* () {
        const queues = yield* Settle.bindQueues("sync-stars", self.client, deadLetters.client);
        yield* queues.sendLater({ login: "octocat" }, 42);
        yield* queues.deadLetter("broken");
      }).pipe(Effect.provide(runtimeContext)),
    );
    expect(self.raw).toEqual([{ body: { login: "octocat" }, options: { delaySeconds: 42 } }]);
    expect(deadLetters.sent).toEqual(["broken"]);
  });

  it("sends enrich messages in batches of at most 100", async () => {
    const queue = fakeQueue();
    await Effect.runPromise(
      Effect.flatMap(EnrichQueue.EnrichQueue, (enrich) =>
        enrich.send(Array.from({ length: 250 }, (_, index) => ({ repoId: repoId(index + 1) }))),
      ).pipe(Effect.provide(Layers.layerEnrichQueue(queue.client).pipe(Layer.provide(runtimeContext)))),
    );
    expect(queue.batches).toEqual([100, 100, 50]);
  });

  it("keeps an icon's plate and size in R2 metadata with immutable caching, and reads an object without them as absent", async () => {
    const objects = new Map<string, { readonly body: unknown; readonly options: R2PutOptions | undefined }>();
    const bucket = {
      put: (key: string, body: unknown, options?: R2PutOptions) =>
        Effect.sync(() => {
          objects.set(key, { body, options });
          return {};
        }),
      head: (key: string) =>
        Effect.succeed(objects.has(key) ? { customMetadata: objects.get(key)?.options?.customMetadata } : null),
    } as unknown as Cloudflare.R2.ReadWriteBucketClient;
    objects.set("v1/git/old.webp", { body: new Uint8Array(), options: { customMetadata: { plate: "dark" } } });
    const read = await Effect.runPromise(
      Effect.flatMap(IconStore.IconStore, (store) =>
        Effect.gen(function* () {
          yield* store.put("v1/git/new.webp", new Uint8Array([1]), { plate: "light", size: 32 });
          return yield* Effect.all([
            store.head("v1/git/new.webp"),
            store.head("v1/git/old.webp"),
            store.head("v1/git/none.webp"),
          ]);
        }),
      ).pipe(Effect.provide(Layers.layerIconStore(bucket).pipe(Layer.provide(runtimeContext)))),
    );
    expect(read).toEqual([Option.some({ plate: "light", size: 32 }), Option.none(), Option.none()]);
    expect(objects.get("v1/git/new.webp")?.options?.httpMetadata).toEqual({
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  it("reads a missing R2 object as None and a stored one as its text", async () => {
    const bucket = {
      get: (key: string) => Effect.succeed(key === "readmes/a" ? { text: () => Effect.succeed("# A") } : null),
      put: () => Effect.succeed({}),
    } as unknown as Cloudflare.R2.ReadWriteBucketClient;
    const read = await Effect.runPromise(
      Effect.flatMap(BlobStore.BlobStore, (blobs) => Effect.all([blobs.get("readmes/a"), blobs.get("readmes/b")])).pipe(
        Effect.provide(Layers.layerBlobStore(bucket).pipe(Layer.provide(runtimeContext))),
      ),
    );
    expect(read).toEqual([Option.some("# A"), Option.none()]);
  });
});

describe("dead letters", () => {
  const dropped = new DbQueryFailed({ operation: "syncRequests.settle", reason: "transport", sqlState: null });

  const recordingDb = (fail = false) => {
    const failed: Array<[string, number]> = [];
    const layer = Layer.succeed(
      Db.Db,
      makeDb({
        syncRequests: {
          settle: (login: string, requestedAt: DateTime.Utc) =>
            fail
              ? Effect.fail(dropped)
              : Effect.sync(() => void failed.push([login, DateTime.toEpochMillis(requestedAt)])),
        },
      }),
    );
    return { failed, layer };
  };

  const handleBatch = (batch: MessageBatch, layer: Layer.Layer<Db.Db>, logs: Array<unknown> = []) =>
    run(
      Settle.handleDeadLetters(
        "sync-stars",
        SyncStarsConsumer.pipeline(share, Layer.mock(StarSync.StarSync, {})),
        5,
      )(Stream.fromIterable(batch.messages)).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
      ),
      batch,
    );

  const handle = (bodies: ReadonlyArray<unknown>, layer: Layer.Layer<Db.Db>, logs: Array<unknown> = []) =>
    handleBatch(batchOf("sync-stars-dead-letters", bodies), layer, logs);

  it("logs the ids of a body it decodes and only the type of one it cannot", async () => {
    const logs: Array<unknown> = [];
    await handle(["secret-looking payload", { login: "octocat", mode: "full" }], recordingDb().layer, logs);
    expect(JSON.stringify(logs)).not.toContain("secret-looking payload");
    expect(logs).toEqual([
      ["Dead letter", { queue: "sync-stars", messageId: "m0", attempts: 1, bodyType: "string" }],
      ["Dead letter", { queue: "sync-stars", messageId: "m1", attempts: 1, login: "octocat", mode: "full" }],
    ]);
  });

  it("logs an enrich dead letter without counting it against the repo", async () => {
    const logs: Array<unknown> = [];
    const touched = Layer.succeed(Db.Db, makeDb());
    await Effect.runPromise(
      Settle.handleDeadLetters(
        "enrich-repo",
        EnrichRepoConsumer.pipeline(Layer.mock(EnrichRepo.EnrichRepo, {})),
        5,
      )(Stream.fromIterable(batchOf("enrich-repo-dead-letters", [{ repoId: 11 }]).messages)).pipe(
        Effect.provide(Layer.merge(touched, Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
      ),
    );
    expect(logs).toEqual([["Dead letter", { queue: "enrich-repo", messageId: "m0", attempts: 1, repoId: 11 }]]);
  });

  it("marks the request a sync carries as failed, and leaves a sync without one alone", async () => {
    const db = recordingDb();
    const requestedAt = Date.parse("2026-11-04T12:00:00Z");
    await handle(
      [
        { login: "No-Such-Login", mode: "incremental", requestedAt },
        { login: "octocat", mode: "full" },
      ],
      db.layer,
    );
    expect(db.failed).toEqual([["No-Such-Login", requestedAt]]);
  });

  it("retries a dead letter whose failed mark does not land, and acks it once the mark lands", async () => {
    const requestedAt = Date.parse("2026-11-04T12:00:00Z");
    const body = { login: "octocat", mode: "incremental", requestedAt };
    const logs: Array<unknown> = [];
    const first = await handleBatch(batchOf("sync-stars-dead-letters", [body]), recordingDb(true).layer, logs);
    expect(first.retryMessages).toEqual([{ msgId: "m0" }]);
    expect(first.explicitAcks).toEqual([]);
    expect(logs).toContainEqual([
      "Dead letter not recorded, retrying",
      { queue: "sync-stars", messageId: "m0", attempts: 1, error: "DbQueryFailed" },
    ]);

    const db = recordingDb();
    const second = await handleBatch(batchOf("sync-stars-dead-letters", [body], 2), db.layer);
    expect(second.explicitAcks).toEqual(["m0"]);
    expect(second.retryMessages).toEqual([]);
    expect(db.failed).toEqual([["octocat", requestedAt]]);
  });

  it("logs and acks a dead letter still unrecorded after its last retry, since nothing would retry it again", async () => {
    const body = { login: "octocat", mode: "incremental", requestedAt: Date.parse("2026-11-04T12:00:00Z") };
    const logs: Array<unknown> = [];
    const last = await handleBatch(batchOf("sync-stars-dead-letters", [body], 6), recordingDb(true).layer, logs);
    expect(last.explicitAcks).toEqual(["m0"]);
    expect(last.retryMessages).toEqual([]);
    expect(logs).toContainEqual([
      "Dead letter dropped unrecorded",
      { queue: "sync-stars", messageId: "m0", attempts: 6, error: "DbQueryFailed" },
    ]);
  });
});
