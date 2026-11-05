import { EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import * as Db from "@stargrep/db";
import * as DateTime from "effect/DateTime";
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
  Summarized: done,
  Embedded: done,
});

export const pipeline = Settle.pipeline({
  schema: EnrichQueue.EnrichRepo,
  run: Effect.fn("EnrichRepoConsumer.run")(function* (bodies) {
    const enricher = yield* EnrichRepo.EnrichRepo;
    const enriched = yield* Effect.result(enricher.enrichRepos(bodies.map((body) => body.repoId)));
    if (Result.isFailure(enriched)) return bodies.map(() => Result.fail(enriched.failure));
    return enriched.success.map(settlementOf);
  }),
  describe: (body) => ({ repoId: body.repoId }),
  onDeadLetter: Effect.fn("EnrichRepoConsumer.markFailed")(function* (body) {
    const db = yield* Db.Db;
    yield* db.repos
      .recordEnrichFailures({ ids: [body.repoId], at: yield* DateTime.now })
      .pipe(
        Effect.catchTag("DbQueryFailed", (error) =>
          Effect.logWarning("Could not count a dead-lettered enrichment as failed", { reason: error.reason }),
        ),
      );
  }),
});
