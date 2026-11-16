import * as Embeddings from "@stargrep/ai/embeddings";
import { embeddingModel } from "@stargrep/ai/models";
import * as TextGeneration from "@stargrep/ai/text-generation";
import { GitHubTokens } from "@stargrep/auth/tokens";
import { IconQueue } from "@stargrep/core/icons";
import { BlobStore, EnrichRepo, SummaryAllowance } from "@stargrep/core/repos";
import * as Db from "@stargrep/db";
import { makeDb, repo } from "@stargrep/db/testing";
import { TokenBudgetExhausted } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import * as Fake from "@stargrep/github/github.fixture";
import { Login } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "vitest";
import * as EnrichRepoConsumer from "../src/consumers/enrich-repo.ts";
import * as Settle from "../src/consumers/settle.ts";
import type { UserGitHubGate } from "../src/github-gate.ts";
import * as UserGate from "../src/user-gate.ts";
import { batchOf, recordingQueues, run, runtimeContext } from "./consumers.fixture.ts";

it("shares the server token's rate-limit deferral across users who spent their own share", async () => {
  const sent: Array<string> = [];
  const limited = Layer.succeed(
    TokenGate.TokenGate,
    TokenGate.TokenGate.of({
      execute: (_operation, request) =>
        Effect.sync(() => {
          sent.push(new URL(request.url).pathname);
          return {
            status: 403,
            headers: Headers.fromInput({ "retry-after": "60" }),
            body: Option.some("You have exceeded a secondary rate limit"),
            rateLimit: {
              resource: Option.none(),
              limit: Option.none(),
              remaining: Option.none(),
              resetAt: Option.none(),
            },
          };
        }),
    }),
  );
  let reads = 0;
  const db = Layer.succeed(
    Db.Db,
    makeDb({
      repos: {
        getMany: (ids) =>
          Effect.andThen(
            reads++ === 1 ? Effect.sleep("2 minutes") : Effect.void,
            Effect.succeed(
              ids.map((id) => ({
                ...repo(id),
                pending: true,
                enrichRetryAt: null,
                enrichFailures: 0,
                summaryRecipe: 0,
                summaryInputHash: null,
              })),
            ),
          ),
      },
    }),
  );
  const enrichers = EnrichRepo.layer.pipe(
    Layer.provide(GitHub.layer),
    Layer.provide(
      Layer.mergeAll(
        db,
        Layer.mock(BlobStore.BlobStore, {}),
        Layer.mock(Embeddings.Embeddings, { model: embeddingModel }),
        Layer.mock(TextGeneration.TextGeneration, { provider: "test", model: "test", batchTimeout: Option.none() }),
        Layer.mock(IconQueue.IconQueue, {}),
        SummaryAllowance.layerUnmetered,
      ),
    ),
  );
  const namespace = {
    getByName: () => ({
      execute: () => Effect.succeed(new TokenBudgetExhausted({ resource: "graphql", resetAt: 9_999_999_999_999 })),
    }),
  } as unknown as Effect.Success<typeof UserGitHubGate>;
  const users = UserGate.layer(namespace).pipe(
    Layer.provide(
      Layer.merge(
        runtimeContext,
        Layer.mock(GitHubTokens, { read: () => Effect.succeed(Redacted.make("test-user-token")) }),
      ),
    ),
  );
  const { queues, later, deadLetters } = recordingQueues();
  const batch = batchOf(
    "enrich-repo",
    Array.from({ length: 100 }, (_, index) =>
      index < 40 ? { repoId: index + 1, userId: `u${Math.floor(index / 10)}` } : { repoId: index + 1 },
    ),
  );
  const result = await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Settle.processBatch(EnrichRepoConsumer.pipeline(enrichers), queues, batch.messages),
      );
      yield* TestClock.adjust("15 minutes");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(limited, users, TestClock.layer()))),
    batch,
  );
  expect(sent).toEqual(Array.from({ length: 4 }, () => "/graphql"));
  expect(later).toHaveLength(100);
  expect(later.slice(0, 10).map((sent) => sent.delaySeconds)).toEqual(Array.from({ length: 10 }, () => 65));
  expect(later.slice(10).map((sent) => sent.delaySeconds)).toEqual(Array.from({ length: 90 }, () => 1));
  expect(deadLetters).toEqual([]);
  expect(result.explicitAcks).toHaveLength(100);
  expect(result.retryMessages).toEqual([]);
});

for (const limit of [
  { name: "HTTP", status: 403, body: "You have exceeded a secondary rate limit" },
  { name: "GraphQL", status: 200, body: '{"errors":[{"type":"RATE_LIMITED","message":"x"}]}' },
])
  for (const serverLimited of [false, true])
    it(`keeps a user's ${limit.name} limit separate after fallback to a ${serverLimited ? "limited" : "healthy"} server`, async () => {
      let userRequests = 0;
      let serverRequests = 0;
      const ownerBody = JSON.stringify(Fake.ownerBodies.user);
      const rateLimit = {
        resource: Option.none(),
        limit: Option.none(),
        remaining: Option.none(),
        resetAt: Option.none(),
      };
      const namespace = {
        getByName: () => ({
          execute: () =>
            Effect.sync(() =>
              userRequests++ === 0
                ? { _tag: "Replied", status: limit.status, headers: { "retry-after": "120" }, body: limit.body }
                : new TokenBudgetExhausted({ resource: "graphql", resetAt: 9_999_999_999_999 }),
            ),
        }),
      } as unknown as Effect.Success<typeof UserGitHubGate>;
      const users = UserGate.layer(namespace).pipe(
        Layer.provide(
          Layer.merge(
            runtimeContext,
            Layer.mock(GitHubTokens, { read: () => Effect.succeed(Redacted.make("test-user-token")) }),
          ),
        ),
      );
      const server = Layer.succeed(
        TokenGate.TokenGate,
        TokenGate.TokenGate.of({
          execute: () =>
            Effect.sync(() => {
              serverRequests++;
              return serverLimited
                ? { status: 429, headers: Headers.fromInput({ "retry-after": "180" }), body: Option.none(), rateLimit }
                : { status: 200, headers: Headers.empty, body: Option.some(ownerBody), rateLimit };
            }),
        }),
      );
      const enrichers = Layer.effect(
        EnrichRepo.EnrichRepo,
        Effect.map(GitHub.GitHub, (github) =>
          EnrichRepo.EnrichRepo.of({
            enrichRepos: (ids) =>
              Effect.gen(function* () {
                const first = yield* Effect.result(github.owner(Login.make("octocat")));
                const second = yield* Effect.result(github.owner(Login.make("octocat")));
                return ids.map((id, index) => {
                  const outcome = index === 0 ? first : second;
                  return Result.isFailure(outcome)
                    ? EnrichRepo.Enrichment.Failed({ id, error: outcome.failure })
                    : EnrichRepo.Enrichment.Unchanged({ id });
                });
              }),
          }),
        ),
      ).pipe(Layer.provide(GitHub.layer));
      const { queues, later } = recordingQueues();
      const batch = batchOf(
        "enrich-repo",
        Array.from({ length: 100 }, (_, index) =>
          index < 10 ? { repoId: index + 1, userId: "u1" } : { repoId: index + 1 },
        ),
      );
      const result = await run(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Settle.processBatch(EnrichRepoConsumer.pipeline(enrichers), queues, batch.messages),
          );
          yield* TestClock.adjust("5 minutes");
          yield* Fiber.join(fiber);
        }).pipe(Effect.provide(Layer.mergeAll(server, users, TestClock.layer()))),
        batch,
      );
      expect(userRequests).toBe(2);
      expect(serverRequests).toBe(serverLimited ? 1 : 19);
      expect(later).toHaveLength(serverLimited ? 100 : 1);
      expect(later[0]?.delaySeconds).toBe(125);
      if (serverLimited)
        expect(later.slice(1).map((entry) => entry.delaySeconds)).toEqual(Array.from({ length: 99 }, () => 185));
      expect(result.explicitAcks).toHaveLength(100);
      expect(result.retryMessages).toEqual([]);
    });

it("lets a later job use its user's reset window while the server token still waits", async () => {
  let userRequests = 0;
  let serverRequests = 0;
  const ownerBody = JSON.stringify(Fake.ownerBodies.user);
  const namespace = {
    getByName: () => ({
      execute: () =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          userRequests++;
          return now < 60_000
            ? new TokenBudgetExhausted({ resource: "graphql", resetAt: 60_000 })
            : { _tag: "Replied", status: 200, headers: {}, body: ownerBody };
        }),
    }),
  } as unknown as Effect.Success<typeof UserGitHubGate>;
  const users = UserGate.layer(namespace).pipe(
    Layer.provide(
      Layer.merge(
        runtimeContext,
        Layer.mock(GitHubTokens, { read: () => Effect.succeed(Redacted.make("test-user-token")) }),
      ),
    ),
  );
  const server = Layer.succeed(
    TokenGate.TokenGate,
    TokenGate.TokenGate.of({
      execute: () =>
        Effect.sync(() => {
          serverRequests++;
          return {
            status: 429,
            headers: Headers.fromInput({ "retry-after": "120" }),
            body: Option.none(),
            rateLimit: {
              resource: Option.none(),
              limit: Option.none(),
              remaining: Option.none(),
              resetAt: Option.none(),
            },
          };
        }),
    }),
  );
  const enrichers = Layer.effect(
    EnrichRepo.EnrichRepo,
    Effect.map(GitHub.GitHub, (github) =>
      EnrichRepo.EnrichRepo.of({
        enrichRepos: (ids) =>
          github.owner(Login.make("octocat")).pipe(Effect.as(ids.map((id) => EnrichRepo.Enrichment.Unchanged({ id })))),
      }),
    ),
  ).pipe(Layer.provide(GitHub.layer));
  const { queues, later } = recordingQueues();
  let waited = false;
  const slowQueue = {
    ...queues,
    sendLater: (body: unknown, delay: number) =>
      Effect.gen(function* () {
        yield* queues.sendLater(body, delay);
        if (!waited) {
          waited = true;
          yield* Effect.sleep("1 minute");
        }
      }),
  };
  const batch = batchOf(
    "enrich-repo",
    Array.from({ length: 20 }, (_, index) => ({ repoId: index + 1, userId: "u1" })),
  );
  const result = await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Settle.processBatch(EnrichRepoConsumer.pipeline(enrichers), slowQueue, batch.messages),
      );
      yield* TestClock.adjust("5 minutes");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(server, users, TestClock.layer()))),
    batch,
  );
  expect(serverRequests).toBe(1);
  expect(userRequests).toBe(2);
  expect(later).toHaveLength(10);
  expect(result.explicitAcks).toHaveLength(20);
  expect(result.retryMessages).toEqual([]);
});
