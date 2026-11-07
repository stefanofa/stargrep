import { expect } from "bun:test";
import { UserId } from "@stargrep/db/auth-schema";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as Memory from "@stargrep/db/memory";
import * as GitHubFake from "@stargrep/github/github.fixture";
import * as it from "@stargrep/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as OwnerAccount from "./owner-account.ts";
import { SyncRequests } from "./sync-requests.ts";

const cases: ReadonlyArray<{ readonly name: string; readonly reply: GitHubFake.Reply; readonly requests: number }> = [
  { name: "server errors and their retries", reply: { status: 502 }, requests: 3 },
  {
    name: "a secondary rate limit and its wait",
    reply: { status: 403, headers: { "retry-after": "60" } },
    requests: 1,
  },
  { name: "a response whose body never finishes", reply: { stream: "hang" }, requests: 1 },
];

for (const { name, reply, requests } of cases)
  it.effect(`bounds the whole sign-in viewer read to five seconds for ${name}`, () => {
    const fake = GitHubFake.layer(() => reply);
    return Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const fiber = yield* Effect.forkChild(Effect.flip(OwnerAccount.importViewer(UserId.make("user-1"))));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "OwnerImportFailed" });
      expect((yield* Clock.currentTimeMillis) - started).toBe(5_000);
      expect(fake.sent).toHaveLength(requests);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          Memory.layerMemory({ embeddingModel: EmbeddingModelId.make("test/owner-import") }),
          Layer.mock(SyncRequests, {}),
        ),
      ),
    );
  });
