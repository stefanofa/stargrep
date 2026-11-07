import * as Embeddings from "@stargrep/ai/embeddings";
import { embeddingModel } from "@stargrep/ai/models";
import * as TextGeneration from "@stargrep/ai/text-generation";
import { GitHubTokens } from "@stargrep/auth/tokens";
import { IconQueue } from "@stargrep/core/icons";
import { BlobStore, EnrichRepo } from "@stargrep/core/repos";
import * as Db from "@stargrep/db";
import { TokenBudgetExhausted } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { RepoId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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
    Db.Db.of({
      repos: {
        getMany: (ids: ReadonlyArray<RepoId>) =>
          Effect.andThen(
            reads++ === 1 ? Effect.sleep("2 minutes") : Effect.void,
            Effect.succeed(ids.map((id) => ({ id, pending: true, enrichRetryAt: null, nodeId: `R_${id}` }))),
          ),
      },
    } as unknown as Db.Db["Service"]),
  );
  const enrichers = EnrichRepo.layer.pipe(
    Layer.provide(GitHub.layer),
    Layer.provide(
      Layer.mergeAll(
        db,
        Layer.mock(BlobStore.BlobStore, {}),
        Layer.mock(Embeddings.Embeddings, { model: embeddingModel }),
        Layer.mock(TextGeneration.TextGeneration, { model: "test" }),
        Layer.mock(IconQueue.IconQueue, {}),
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
