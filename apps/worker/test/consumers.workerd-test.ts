import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Embeddings from "@stargrep/ai/embeddings";
import {
  AiKeyMissing,
  AiModelNotFound,
  AiOutputInvalid,
  AiRequestFailed,
  AiTimeout,
  AiUnavailable,
} from "@stargrep/ai/errors";
import * as Summarize from "@stargrep/ai/summarize";
import { BlobStore, EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { EmbeddingModelId, EmbeddingModelMismatch } from "@stargrep/db/embedding";
import { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
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
import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import { aiGatewayKey } from "@stargrep/runtime/config";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
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
import * as BudgetShare from "../src/budget-share.ts";
import * as EnrichRepoConsumer from "../src/consumers/enrich-repo.ts";
import * as Settle from "../src/consumers/settle.ts";
import * as SyncStarsConsumer from "../src/consumers/sync-stars.ts";
import * as Layers from "../src/layers.ts";
import * as Secrets from "../src/secrets.ts";

const report = { listed: 1, added: 1, unchanged: 0, unstarred: 0, enqueued: 1, shifted: false };
const repoId = Schema.decodeSync(RepoId);
const inMillis = (millis: number) => Effect.map(Clock.currentTimeMillis, (now) => now + millis);

const recordingQueues = (fail = false) => {
  const later: Array<{ readonly body: unknown; readonly delaySeconds: number }> = [];
  const deadLetters: Array<unknown> = [];
  const failure = new Settle.QueueSendFailed({ queue: "test", cause: new Error("queue down") });
  const queues: Settle.Queues = {
    name: "test",
    sendLater: (body, delaySeconds) =>
      fail ? Effect.fail(failure) : Effect.sync(() => void later.push({ body, delaySeconds })),
    deadLetter: (body) => (fail ? Effect.fail(failure) : Effect.sync(() => void deadLetters.push(body))),
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

const syncing = (layer: Layer.Layer<StarSync.StarSync>) => (queues: Settle.Queues, batch: MessageBatch) =>
  run(Settle.processBatch(SyncStarsConsumer.pipeline, queues, batch.messages).pipe(Effect.provide(layer)), batch);

const runtimeContext = Layer.succeed(
  RuntimeContext,
  RuntimeContext.of({
    Type: "test",
    id: "test",
    env: {},
    get: () => Effect.undefined,
    set: (id) => Effect.succeed(id),
  }),
);

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

  it("acks a synced account and retries one whose database connection dropped", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [
      { accountId: 1, mode: "full" },
      { accountId: 2, mode: "incremental" },
    ]);
    const layer = Layer.mock(StarSync.StarSync, {
      sync: (request) =>
        request.accountId === Schema.decodeSync(GitHubAccountId)(2)
          ? Effect.fail(new DbQueryFailed({ operation: "stars.upsert", reason: "transport", sqlState: null }))
          : Effect.succeed(report),
    });
    const result = await syncing(layer)(queues, batch);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([{ msgId: "m1" }]);
    expect(deadLetters).toEqual([]);
  });

  it("sends a sync that ran out of GitHub budget again after the reset, without spending a retry", async () => {
    const { queues, later } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "incremental" }]);
    const layer = Layer.mock(StarSync.StarSync, {
      syncLogin: () =>
        Effect.flatMap(inMillis(600_000), (resetAt) =>
          Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt })),
        ),
    });
    const result = await syncing(layer)(queues, batch);
    expect(later).toHaveLength(1);
    expect(later[0]?.body).toEqual({ login: "octocat", mode: "incremental" });
    expect(later[0]?.delaySeconds).toBeGreaterThanOrEqual(600);
    expect(later[0]?.delaySeconds).toBeLessThanOrEqual(606);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
  });

  const unusedDb = Layer.succeed(Db.Db, Db.Db.of({} as Db.Db["Service"]));

  it("dead-letters a sync on a stage with no GitHub token on its first attempt", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "full" }]);
    const layer = StarSync.layer.pipe(
      Layer.provide(GitHub.layer.pipe(Layer.provide(TokenGate.layerMissing))),
      Layer.provide(unusedDb),
      Layer.provide(EnrichQueue.layerMemory().layer),
    );
    const result = await syncing(layer)(queues, batch);
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
    const layer = StarSync.layer.pipe(
      Layer.provide(github.layer),
      Layer.provide(unusedDb),
      Layer.provide(EnrichQueue.layerMemory().layer),
    );
    const ctx = createExecutionContext();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Settle.processBatch(SyncStarsConsumer.pipeline, queues, batch.messages));
        yield* TestClock.adjust("3 minutes");
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
    );
    const result = await getQueueResult(batch, ctx);
    expect(deadLetters).toEqual([]);
    expect(later).toEqual([{ body: { login: "octocat", mode: "full" }, delaySeconds: 65 }]);
    expect(github.sent).toHaveLength(4);
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
      Settle.processBatch(SyncStarsConsumer.pipeline, queues, batch.messages).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
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
      Settle.processBatch(SyncStarsConsumer.pipeline, queues, batch.messages).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(StarSync.StarSync, {}),
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

describe("enrich-repo consumer", () => {
  it("settles each message by its position in the batch", async () => {
    const { queues, deadLetters } = recordingQueues();
    const batch = batchOf("enrich-repo", [{ repoId: 1 }, { repoId: 2 }, { repo: "x" }, { repoId: 3 }, { repoId: 1 }]);
    const asked: Array<ReadonlyArray<RepoId>> = [];
    const layer = Layer.mock(EnrichRepo.EnrichRepo, {
      enrichRepos: (ids) => {
        asked.push(ids);
        return Effect.succeed([
          EnrichRepo.Enrichment.Summarized({ id: repoId(1), summary: { summary: "s", keywords: [], kind: null } }),
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
      Settle.processBatch(EnrichRepoConsumer.pipeline, queues, batch.messages).pipe(Effect.provide(layer)),
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
      Settle.processBatch(EnrichRepoConsumer.pipeline, queues, batch.messages).pipe(Effect.provide(layer)),
      batch,
    );
    expect(later.map((sent) => sent.body)).toEqual([{ repoId: 3 }, { repoId: 4 }]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("settlement table", () => {
  const now = 1_000_000;
  const model = Schema.decodeSync(EmbeddingModelId)("voyage/voyage-4");
  const endpoint = { operation: "list-stars", method: "GET", path: "/users/octocat/starred" } as const;
  const budgetExhausted = new TokenBudgetExhausted({ resource: "core", resetAt: now + 5_000 });
  const rateLimited = new RateLimited({ operation: "readme", resource: "core", retryAfterMillis: 90_000 });
  const cases = {
    TokenBudgetExhausted: [[budgetExhausted, "Defer"]],
    RateLimited: [[rateLimited, "Defer"]],
    Unauthorized: [[new Unauthorized({ operation: "account" }), "DeadLetter"]],
    GitHubTokenMissing: [[new GitHubTokenMissing({ operation: "account" }), "DeadLetter"]],
    AiKeyMissing: [[new AiKeyMissing({ operation: "generate", model: "m" }), "DeadLetter"]],
    AccountNotFound: [[new AccountNotFound({ accountId: Schema.decodeSync(GitHubAccountId)(7) }), "DeadLetter"]],
    EmbeddingModelMismatch: [[new EmbeddingModelMismatch({ expected: model, received: model }), "DeadLetter"]],
    NotFound: [[new NotFound({ operation: "account", path: "/users/ghost" }), "DeadLetter"]],
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
    AiTimeout: [[new AiTimeout({ operation: "embed", model: "m", timeoutMillis: 30_000 }), "Retry"]],
    AiUnavailable: [[new AiUnavailable({ operation: "generate", model: "m", detail: "503" }), "Retry"]],
    AiRequestFailed: [[new AiRequestFailed({ operation: "generate", model: "m", detail: "400" }), "DeadLetter"]],
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

describe("stage secrets", () => {
  const withEnv = (env: Record<string, string>) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

  it("treats an empty secret as missing", async () => {
    const read = await Effect.runPromise(
      Effect.all([Secrets.githubToken, aiGatewayKey]).pipe(
        withEnv({ STARGREP_GITHUB_TOKEN: "", AI_GATEWAY_API_KEY: "" }),
      ),
    );
    expect(read).toEqual([Option.none(), Option.none()]);
  });

  it("fails a prod deploy that lacks either secret or has an empty one, and deploys a preview stage without them", async () => {
    const both = { STARGREP_GITHUB_TOKEN: "token", AI_GATEWAY_API_KEY: "key" };
    const outcomes = await Promise.all(
      [
        Secrets.requireStageSecrets("prod").pipe(withEnv({})),
        Secrets.requireStageSecrets("prod").pipe(withEnv({ STARGREP_GITHUB_TOKEN: "token" })),
        Secrets.requireStageSecrets("prod").pipe(withEnv({ ...both, AI_GATEWAY_API_KEY: "" })),
        Secrets.requireStageSecrets("prod").pipe(withEnv(both)),
        Secrets.requireStageSecrets("pr-18").pipe(withEnv({})),
      ].map((check) => Effect.runPromiseExit(check)),
    );
    expect(outcomes.map(Exit.isSuccess)).toEqual([false, false, false, true, true]);
  });

  const share = (stage: string, env: Record<string, string>) =>
    Effect.runPromiseExit(BudgetShare.stageBudgetShare(stage).pipe(withEnv(env)));

  it("reads the GitHub budget share as a number in (0, 1] and defaults it to 0.5", async () => {
    const outcomes = await Promise.all(
      [{}, { GITHUB_BUDGET_SHARE: "0.02" }, { GITHUB_BUDGET_SHARE: "1" }].map((env) => share("pr-18", env)),
    );
    expect(outcomes).toEqual([Exit.succeed(0.5), Exit.succeed(0.02), Exit.succeed(1)]);
    const refused = await Promise.all(
      ["0", "-0.1", "1.5", "half", "NaN"].map((value) => share("pr-18", { GITHUB_BUDGET_SHARE: value })),
    );
    expect(refused.map(Exit.isFailure)).toEqual([true, true, true, true, true]);
  });

  it("fails a prod deploy with any budget share other than the default", async () => {
    const outcomes = await Promise.all(
      [{}, { GITHUB_BUDGET_SHARE: "0.5" }, { GITHUB_BUDGET_SHARE: "0.02" }, { GITHUB_BUDGET_SHARE: "1" }].map((env) =>
        share("prod", env),
      ),
    );
    expect(outcomes.map(Exit.isSuccess)).toEqual([true, true, false, false]);
    expect(String(outcomes[2])).toContain("prod takes a GitHub budget share of 0.5");
  });

  it("fails every model call with AiKeyMissing when the AI Gateway key is empty", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* Layers.aiModels;
        return yield* Effect.gen(function* () {
          const embeddings = yield* Embeddings.Embeddings;
          const facts = { fullName: "owner/repo", description: null, topics: [], language: null, readme: null };
          return [
            (yield* Effect.flip(Summarize.summarize(facts)))._tag,
            (yield* Effect.flip(embeddings.embed(["x"])))._tag,
          ];
        }).pipe(Effect.provide(ai));
      }).pipe(withEnv({ AI_GATEWAY_API_KEY: "" })),
    );
    expect(errors).toEqual(["AiKeyMissing", "AiKeyMissing"]);
  });
});

describe("dead letters", () => {
  it("logs the ids of a body it decodes and only the type of one it cannot", async () => {
    const logs: Array<unknown> = [];
    const batch = batchOf("sync-stars-dead-letters", ["secret-looking payload", { login: "octocat", mode: "full" }]);
    await Effect.runPromise(
      Settle.logDeadLetters(
        "sync-stars",
        SyncStarsConsumer.pipeline,
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

  it("marks a dead-lettered login sync as failed and leaves an account sync alone", async () => {
    const failed: Array<string> = [];
    const db = Layer.succeed(
      Db.Db,
      Db.Db.of({
        syncRequests: { markFailed: (login: string) => Effect.sync(() => void failed.push(login)) },
      } as unknown as Db.Db["Service"]),
    );
    const batch = batchOf("sync-stars-dead-letters", [
      { login: "No-Such-Login", mode: "incremental" },
      { accountId: 5, mode: "full" },
    ]);
    await Effect.runPromise(
      Settle.logDeadLetters(
        "sync-stars",
        SyncStarsConsumer.pipeline,
        SyncStarsConsumer.markFailed(db),
      )(Stream.fromIterable(batch.messages)).pipe(Effect.provide(Logger.layer([Logger.make(() => undefined)]))),
    );
    expect(failed).toEqual(["No-Such-Login"]);
  });
});
