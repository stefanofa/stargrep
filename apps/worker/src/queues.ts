import * as Cloudflare from "@alchemy.run/cloudflare";
import type { EnrichRepo } from "@stargrep/core/repos";
import type { StarSync } from "@stargrep/core/stars";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EnrichRepoConsumer from "./consumers/enrich-repo.ts";
import * as Settle from "./consumers/settle.ts";
import * as SyncStarsConsumer from "./consumers/sync-stars.ts";
import * as Layers from "./layers.ts";

export const SyncStars = Cloudflare.Queues.Queue("SyncStars");
export const SyncStarsDeadLetters = Cloudflare.Queues.Queue("SyncStarsDeadLetters");
export const EnrichRepos = Cloudflare.Queues.Queue("EnrichRepos");
export const EnrichReposDeadLetters = Cloudflare.Queues.Queue("EnrichReposDeadLetters");

const bindQueues = Effect.fn("Queues.bind")(function* (
  name: string,
  self: Cloudflare.Queues.WriteQueueClient,
  deadLetters: Cloudflare.Queues.WriteQueueClient,
) {
  const run = yield* Layers.inRuntime;
  return {
    name,
    sendLater: (body, delaySeconds) =>
      run(Effect.flatMap(self.raw, (raw) => Effect.tryPromise(() => raw.send(body, { delaySeconds })))).pipe(
        Effect.mapError((cause) => new Settle.QueueSendFailed({ queue: name, cause })),
      ),
    deadLetter: (body) =>
      run(deadLetters.send(body)).pipe(
        Effect.mapError((cause) => new Settle.QueueSendFailed({ queue: `${name} dead letters`, cause })),
      ),
  } satisfies Settle.Queues;
});

interface Pipeline<R> {
  readonly name: string;
  readonly queue: typeof SyncStars;
  readonly deadLetters: typeof SyncStars;
  readonly settings: Omit<Cloudflare.Queues.MessagesProps, "deadLetterQueue">;
  readonly processBatch: (
    queues: Settle.Queues,
    messages: ReadonlyArray<Settle.Message>,
  ) => Effect.Effect<void, never, R>;
  readonly describe: (body: unknown) => Record<string, unknown>;
}

const consume = Effect.fn("Queues.consume")(function* <R, E>(
  pipeline: Pipeline<R>,
  runtime: Layer.Layer<NoInfer<R>, E, RuntimeContext>,
) {
  const queue = yield* pipeline.queue;
  const deadLetters = yield* pipeline.deadLetters;
  const self = yield* Cloudflare.Queues.WriteQueue(queue);
  const deadLetterQueue = yield* Cloudflare.Queues.WriteQueue(deadLetters);
  yield* Cloudflare.Queues.consumeQueueMessages(
    queue,
    { ...pipeline.settings, deadLetterQueue: deadLetters },
    (stream) =>
      Effect.gen(function* () {
        const queues = yield* bindQueues(pipeline.name, self, deadLetterQueue);
        yield* pipeline.processBatch(queues, yield* Stream.runCollect(stream));
      }).pipe(Effect.provide(runtime)),
  );
  yield* Cloudflare.Queues.consumeQueueMessages(
    deadLetters,
    { batchSize: 10, maxWaitTime: "1 second" },
    Settle.logDeadLetters(pipeline.name, pipeline.describe),
  );
});

const retries = { maxRetries: 5, retryDelay: "1 minute" } as const;

export const consumeAll = <E>(runtime: Layer.Layer<StarSync.StarSync | EnrichRepo.EnrichRepo, E, RuntimeContext>) =>
  Effect.all([
    consume(
      {
        name: "sync-stars",
        queue: SyncStars,
        deadLetters: SyncStarsDeadLetters,
        settings: { batchSize: 5, maxWaitTime: "1 second", ...retries },
        processBatch: SyncStarsConsumer.processBatch,
        describe: SyncStarsConsumer.describe,
      },
      runtime,
    ),
    // One batch at a time: a repo several accounts starred arrives once per account, and a later batch
    // finds it enriched instead of paying for a second summary.
    consume(
      {
        name: "enrich-repo",
        queue: EnrichRepos,
        deadLetters: EnrichReposDeadLetters,
        settings: { batchSize: 100, maxConcurrency: 1, maxWaitTime: "5 seconds", ...retries },
        processBatch: EnrichRepoConsumer.processBatch,
        describe: EnrichRepoConsumer.describe,
      },
      runtime,
    ),
  ]);
