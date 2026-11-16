import { EnrichQueue, EnrichRepo } from "@stargrep/core/repos";
import type { UserId } from "@stargrep/db/auth-schema";
import type { RepoId } from "@stargrep/github/schemas";
import type * as TokenGate from "@stargrep/github/token-gate";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { UserGates } from "../user-gate.ts";
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
  Capped: done,
  Summarized: done,
  Embedded: done,
});

// Ten repos of one user need at most three rounds of four model calls, and a chunk's users run one after another, so
// ten users can need ten rounds. The consumer's batch size in queues.ts keeps those rounds inside the deadline.
// Cloudflare ends a queue invocation at 15 minutes, so the deadline leaves time to settle the messages it stopped.
export const chunks: Settle.Chunks<EnrichQueue.EnrichRepo> = {
  size: 10,
  deadline: Duration.minutes(10),
  gate: (body) => (body.userId === undefined ? "server" : undefined),
};

interface Group {
  readonly userId: UserId | undefined;
  readonly positions: Array<number>;
  readonly repoIds: Array<RepoId>;
}

// Repos a signed-in user's import brought in are read on that user's token, the rest on the server's, so each group of a
// batch runs over its own gate. A group that aborts fails only its own messages.
export const pipeline = <R>(enrichers: Layer.Layer<EnrichRepo.EnrichRepo, never, TokenGate.TokenGate | R>) =>
  Settle.pipeline({
    schema: EnrichQueue.EnrichRepo,
    run: Effect.fn("EnrichRepoConsumer.run")(function* (deliveries) {
      const users = yield* UserGates;
      const groups = new Map<string, Group>();
      deliveries.forEach(({ body }, position) => {
        const key = body.userId ?? "";
        const group = groups.get(key) ?? { userId: body.userId, positions: [], repoIds: [] };
        group.positions.push(position);
        group.repoIds.push(body.repoId);
        groups.set(key, group);
      });
      const settled = new Array<Result.Result<Settle.Settlement, Settle.Failure>>(deliveries.length);
      yield* Effect.forEach(
        groups.values(),
        Effect.fnUntraced(function* ({ userId, positions, repoIds }) {
          const gate = yield* users.forJob({ paidBy: userId });
          const enricher = Settle.onGate(enrichers, gate);
          const enriched = yield* EnrichRepo.EnrichRepo.use((service) => service.enrichRepos(repoIds)).pipe(
            Effect.provide(enricher),
            Effect.result,
          );
          const outcomes = Result.isFailure(enriched)
            ? repoIds.map(() => Result.fail(enriched.failure))
            : enriched.success.map(settlementOf);
          for (const [position, outcome] of Arr.zip(positions, outcomes)) {
            settled[position] =
              Result.isFailure(outcome) &&
              (outcome.failure._tag === "RateLimited" || outcome.failure._tag === "TokenBudgetExhausted")
                ? Result.fail(yield* gate.defer(outcome.failure))
                : outcome;
          }
        }),
        { discard: true },
      );
      return settled;
    }),
    describe: (body) => ({ repoId: body.repoId }),
    chunks,
  });
