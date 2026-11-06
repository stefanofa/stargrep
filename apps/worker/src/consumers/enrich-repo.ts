import { EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Settle from "./settle.ts";

const done = () => Result.succeed<Settle.Settlement>(Settle.Settlement.Done());

const settlementOf = EnrichRepo.Enrichment.$match({
  Failed: (outcome): Result.Result<Settle.Settlement, Settle.Failure> => Result.fail(outcome.error),
  Stale: (outcome) => Result.succeed(Settle.Settlement.Retry({ error: outcome._tag })),
  Unchanged: done,
  NotFound: done,
  NoNodeId: done,
  Gone: done,
  Backoff: done,
  Summarized: done,
  Embedded: done,
});

export const pipeline = Settle.pipeline({
  schema: EnrichQueue.EnrichRepo,
  run: Effect.fn("EnrichRepoConsumer.run")(function* (deliveries) {
    const enricher = yield* EnrichRepo.EnrichRepo;
    const enriched = yield* Effect.result(enricher.enrichRepos(deliveries.map(({ body }) => body.repoId)));
    if (Result.isFailure(enriched)) return deliveries.map(() => Result.fail(enriched.failure));
    return enriched.success.map(settlementOf);
  }),
  describe: (body) => ({ repoId: body.repoId }),
});
