import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Embeddings from "@stargrep/ai/embeddings";
import type * as TextGeneration from "@stargrep/ai/text-generation";
import type { FetchIcon, IconQueue } from "@stargrep/core/icons";
import { type BlobStore, type EnrichQueue, EnrichRepo, type SummaryAllowance } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import * as GitHub from "@stargrep/github/github";
import type { BudgetShare } from "@stargrep/github/schemas";
import type * as TokenGate from "@stargrep/github/token-gate";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Observe } from "./analytics.ts";
import * as EnrichRepoConsumer from "./consumers/enrich-repo.ts";
import * as FetchIconConsumer from "./consumers/fetch-icon.ts";
import * as Settle from "./consumers/settle.ts";
import * as SyncStarsConsumer from "./consumers/sync-stars.ts";
import type { UserGates } from "./user-gate.ts";

export const SyncStars = Cloudflare.Queues.Queue("SyncStars");
const SyncStarsDeadLetters = Cloudflare.Queues.Queue("SyncStarsDeadLetters");
export const EnrichRepos = Cloudflare.Queues.Queue("EnrichRepos");
const EnrichReposDeadLetters = Cloudflare.Queues.Queue("EnrichReposDeadLetters");
export const FetchIcons = Cloudflare.Queues.Queue("FetchIcons");
const FetchIconsDeadLetters = Cloudflare.Queues.Queue("FetchIconsDeadLetters");

export const queueNames = { syncStars: "sync-stars", enrichRepo: "enrich-repo", fetchIcon: "fetch-icon" } as const;

const retries = { maxRetries: 5, retryDelay: "1 minute" } as const;

const consume = Effect.fn("Queues.consume")(function* <A, R, D, E>(
  name: string,
  queues: { readonly queue: typeof SyncStars; readonly deadLetters: typeof SyncStars },
  settings: Omit<Cloudflare.Queues.MessagesProps, "deadLetterQueue">,
  pipeline: Settle.Pipeline<A, R, D>,
  runtime: Layer.Layer<NoInfer<R | D>, E, RuntimeContext>,
  observe: Observe,
) {
  const queue = yield* queues.queue;
  const deadLetters = yield* queues.deadLetters;
  const self = yield* Cloudflare.Queues.WriteQueue(queue);
  const deadLetterQueue = yield* Cloudflare.Queues.WriteQueue(deadLetters);
  yield* Cloudflare.Queues.consumeQueueMessages(queue, { ...settings, deadLetterQueue: deadLetters }, (stream) =>
    Effect.gen(function* () {
      const bound = yield* Settle.bindQueues(name, self, deadLetterQueue);
      yield* Settle.processBatch(pipeline, bound, yield* Stream.runCollect(Stream.map(stream, Settle.settleOnce)));
    }).pipe(Effect.provide(runtime), observe(`Queue ${name} batch`)),
  );
  yield* Cloudflare.Queues.consumeQueueMessages(
    deadLetters,
    { batchSize: 10, maxWaitTime: "1 second", ...retries },
    (stream) =>
      Settle.handleDeadLetters(
        name,
        pipeline,
        retries.maxRetries,
      )(Stream.map(stream, Settle.settleOnce)).pipe(Effect.provide(runtime), observe(`Queue ${name} dead letters`)),
  );
});

const syncs = StarSync.layer.pipe(Layer.provide(GitHub.layer));
const enrichers = EnrichRepo.layer.pipe(Layer.provide(GitHub.layer));

export const consumeAll = <E>(
  runtime: Layer.Layer<
    | TokenGate.TokenGate
    | UserGates
    | EnrichQueue.EnrichQueue
    | FetchIcon.FetchIcon
    | IconQueue.IconQueue
    | BlobStore.BlobStore
    | TextGeneration.TextGeneration
    | Embeddings.Embeddings
    | SummaryAllowance.SummaryAllowance
    | Db.Db,
    E,
    RuntimeContext
  >,
  share: BudgetShare,
  observe: Observe,
) =>
  Effect.all([
    consume(
      queueNames.syncStars,
      { queue: SyncStars, deadLetters: SyncStarsDeadLetters },
      { batchSize: 5, maxWaitTime: "1 second", ...retries },
      SyncStarsConsumer.pipeline(share, syncs),
      runtime,
      observe,
    ),
    // A summary thinks, so a round of four direct calls takes about 15 s. Thirty messages are three chunks of at most ten
    // rounds each, about 8 minutes when every repo has its own user, inside EnrichRepoConsumer's 10-minute deadline.
    consume(
      queueNames.enrichRepo,
      { queue: EnrichRepos, deadLetters: EnrichReposDeadLetters },
      { batchSize: 30, maxConcurrency: 1, maxWaitTime: "5 seconds", ...retries },
      EnrichRepoConsumer.pipeline(enrichers),
      runtime,
      observe,
    ),
    consume(
      queueNames.fetchIcon,
      { queue: FetchIcons, deadLetters: FetchIconsDeadLetters },
      { batchSize: 10, maxConcurrency: 2, maxWaitTime: "5 seconds", ...retries },
      FetchIconConsumer.pipeline,
      runtime,
      observe,
    ),
  ]);
