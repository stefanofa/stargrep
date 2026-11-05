import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as EnrichQueue from "./enrich-queue.ts";
import * as EnrichRetry from "./enrich-retry.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const repoId = Schema.decodeSync(RepoId);
const owner = Schema.decodeSync(Login)("owner");
const start = Date.parse("2026-11-05T12:00:00Z");
const queue = EnrichQueue.layerMemory();

const refs = (ids: ReadonlyArray<number>) =>
  ids.map((n) => ({
    id: repoId(n),
    nodeId: RepoNodeId.make(`R_${n}`),
    owner,
    name: Schema.decodeSync(RepoName)(`repo-${n}`),
  }));

const reset = (ids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    queue.sent.length = 0;
    yield* (yield* TestDatabase.TestDatabase).query("truncate repos cascade");
    yield* TestClock.setTime(start);
    yield* (yield* Db.Db).repos.upsertRefs(refs(ids));
  });

const fail = (ids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    yield* db.repos.recordEnrichFailures({
      ids: ids.map((n) => repoId(n)),
      at: yield* DateTime.now,
      retryDelays: EnrichRetry.retryDelays,
    });
  });

const sweep = Effect.gen(function* () {
  const before = queue.sent.length;
  yield* EnrichRetry.sweep();
  return queue.sent.slice(before).map((message) => message.repoId);
});

it.layer(Layer.merge(TestDatabase.layerMemory({ embeddingModel }), queue.layer), { timeout: 30_000 })(
  "EnrichRetry.sweep",
  (it) => {
    it.effect("sends pending repos that never failed, and leaves read repos alone", () =>
      Effect.gen(function* () {
        yield* reset([1, 2]);
        yield* (yield* TestDatabase.TestDatabase).query(
          "update repos set summary = 's', embedding_model = $1 where id = 2",
          [embeddingModel],
        );
        expect(yield* sweep).toEqual([repoId(1)]);
      }),
    );

    it.effect("waits out each backoff, then stops sending a repo once it reaches the cap", () =>
      Effect.gen(function* () {
        yield* reset([7]);
        const tries: Array<string> = [];
        const tick = (label: string) =>
          Effect.map(sweep, (sent) => {
            if (sent.length > 0) tries.push(label);
          });

        yield* fail([7]);
        yield* tick("right after the first failure");
        yield* TestClock.adjust("9 minutes");
        yield* tick("9 minutes after the first failure");
        yield* TestClock.adjust("1 minute");
        yield* tick("10 minutes after the first failure");

        yield* fail([7]);
        yield* TestClock.adjust("59 minutes");
        yield* tick("59 minutes after the second failure");
        yield* TestClock.adjust("1 minute");
        yield* tick("an hour after the second failure");

        yield* fail([7]);
        yield* TestClock.adjust("30 days");
        yield* tick("30 days after the third failure");

        expect(tries).toEqual(["10 minutes after the first failure", "an hour after the second failure"]);
      }),
    );

    it.effect("has one delay for each failure under the cap", () =>
      Effect.sync(() => expect(EnrichRetry.retryDelays.length + 1).toBe(Db.enrichFailureCap)),
    );

    it.effect("sends at most one batch per run, with retries ahead of repos that never failed", () =>
      Effect.gen(function* () {
        const ids = Array.from({ length: EnrichRetry.sweepBatch + 5 }, (_, index) => 1000 + index);
        yield* reset(ids);
        const retried = ids.at(-1) ?? 0;
        yield* fail([retried]);
        yield* TestClock.adjust("10 minutes");

        const first = yield* sweep;
        expect(first).toHaveLength(EnrichRetry.sweepBatch);
        expect(first[0]).toBe(repoId(retried));
        expect(first.slice(1)).toEqual(ids.slice(0, EnrichRetry.sweepBatch - 1).map((n) => repoId(n)));
      }),
    );
  },
);
