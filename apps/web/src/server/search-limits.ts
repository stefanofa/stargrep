import * as Allowance from "@stargrep/ai/allowance";
import { AiSpendLimited } from "@stargrep/ai/errors";
import * as Effect from "effect/Effect";

interface PlannerLimits {
  readonly perCaller: RateLimit;
  readonly overall: RateLimit;
}

// A planner call is worth more than a search that answers without one, so a limiter outage lets the call through.
const take = (limit: RateLimit, key: string, name: AiSpendLimited["limit"]) =>
  Effect.tryPromise(() => limit.limit({ key })).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.logWarning("Planner allowance could not be checked, so the call goes ahead", { limit: name }),
      onSuccess: ({ success }) =>
        success ? Effect.void : Effect.fail(new AiSpendLimited({ operation: "generate", limit: name })),
    }),
  );

// Wraps the planner already in context. Embeddings are not metered, because a query embedding costs a tiny fraction of
// a planner call and the search limit already bounds them per network.
export const layerPlannerAllowance = (limits: PlannerLimits, caller: string) =>
  Allowance.layer(
    take(limits.perCaller, caller, "caller").pipe(
      Effect.andThen(take(limits.overall, "all", "overall")),
      Effect.withSpan("PlannerAllowance.take"),
    ),
  );
