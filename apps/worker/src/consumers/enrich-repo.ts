import { EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import type { RepoId } from "@stargrep/github/schemas";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Settle from "./settle.ts";

const decodeMessage = Schema.decodeUnknownEffect(EnrichQueue.EnrichRepo);
const isMessage = Schema.is(EnrichQueue.EnrichRepo);

const settlementOf = (outcome: EnrichRepo.Enrichment, now: number): Settle.Settlement => {
  switch (outcome._tag) {
    case "Failed":
      return Settle.afterFailure(outcome.error, now);
    case "Stale":
      return Settle.Settlement.Retry({ error: outcome._tag });
    default:
      return Settle.Settlement.Done();
  }
};

export const handleBatch = Effect.fn("EnrichRepoConsumer.handleBatch")(function* (
  messages: ReadonlyArray<Settle.Message>,
) {
  const decoded = yield* Effect.forEach(messages, (message) => Effect.result(decodeMessage(message.body)));
  const ids = decoded.flatMap((result): Array<RepoId> => (Result.isSuccess(result) ? [result.success.repoId] : []));
  const enricher = yield* EnrichRepo.EnrichRepo;
  const enriched = ids.length === 0 ? Result.succeed([]) : yield* Effect.result(enricher.enrichRepos(ids, "direct"));
  const now = yield* Clock.currentTimeMillis;
  const byId = new Map<number, EnrichRepo.Enrichment>(
    Result.isSuccess(enriched) ? enriched.success.map((outcome) => [outcome.id, outcome]) : [],
  );
  return decoded.map((result): Settle.Settlement => {
    if (Result.isFailure(result)) return Settle.Settlement.DeadLetter({ error: result.failure._tag });
    if (Result.isFailure(enriched)) return Settle.afterFailure(enriched.failure, now);
    const outcome = byId.get(result.success.repoId);
    return outcome === undefined ? Settle.Settlement.Retry({ error: "Missing" }) : settlementOf(outcome, now);
  });
});

export const processBatch = Effect.fn("EnrichRepoConsumer.processBatch")(function* (
  queues: Settle.Queues,
  messages: ReadonlyArray<Settle.Message>,
) {
  const settlements = yield* handleBatch(messages);
  yield* Effect.forEach(messages, (message, index) =>
    Settle.settle(queues, message, settlements[index] ?? Settle.Settlement.Retry({ error: "Missing" })),
  );
});

export const describe = (body: unknown) =>
  isMessage(body)
    ? { repoId: body.repoId }
    : { bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body };
