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

export const SyncStars = Cloudflare.Queues.Queue("SyncStars");
const SyncStarsDeadLetters = Cloudflare.Queues.Queue("SyncStarsDeadLetters");
export const EnrichRepos = Cloudflare.Queues.Queue("EnrichRepos");
const EnrichReposDeadLetters = Cloudflare.Queues.Queue("EnrichReposDeadLetters");

export const queueNames = { syncStars: "sync-stars", enrichRepo: "enrich-repo" } as const;

const retries = { maxRetries: 5, retryDelay: "1 minute" } as const;

const consume = Effect.fn("Queues.consume")(function* <A, R, E>(
  name: string,
  queues: { readonly queue: typeof SyncStars; readonly deadLetters: typeof SyncStars },
  settings: Omit<Cloudflare.Queues.MessagesProps, "deadLetterQueue">,
  pipeline: Settle.Pipeline<A, R>,
  runtime: Layer.Layer<NoInfer<R>, E, RuntimeContext>,
) {
  const queue = yield* queues.queue;
  const deadLetters = yield* queues.deadLetters;
  const self = yield* Cloudflare.Queues.WriteQueue(queue);
  const deadLetterQueue = yield* Cloudflare.Queues.WriteQueue(deadLetters);
  yield* Cloudflare.Queues.consumeQueueMessages(queue, { ...settings, deadLetterQueue: deadLetters }, (stream) =>
    Effect.gen(function* () {
      const bound = yield* Settle.bindQueues(name, self, deadLetterQueue);
      yield* Settle.processBatch(pipeline, bound, yield* Stream.runCollect(stream));
    }).pipe(Effect.provide(runtime)),
  );
  yield* Cloudflare.Queues.consumeQueueMessages(
    deadLetters,
    { batchSize: 10, maxWaitTime: "1 second" },
    Settle.logDeadLetters(name, pipeline),
  );
});

export const consumeAll = <E>(runtime: Layer.Layer<StarSync.StarSync | EnrichRepo.EnrichRepo, E, RuntimeContext>) =>
  Effect.all([
    consume(
      queueNames.syncStars,
      { queue: SyncStars, deadLetters: SyncStarsDeadLetters },
      { batchSize: 5, maxWaitTime: "1 second", ...retries },
      SyncStarsConsumer.pipeline,
      runtime,
    ),
    consume(
      queueNames.enrichRepo,
      { queue: EnrichRepos, deadLetters: EnrichReposDeadLetters },
      { batchSize: 100, maxConcurrency: 1, maxWaitTime: "5 seconds", ...retries },
      EnrichRepoConsumer.pipeline,
      runtime,
    ),
  ]);
