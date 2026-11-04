import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PlannerPrompt from "./planner-prompt.ts";
import * as QueryPlan from "./query-plan.ts";
import * as SearchCache from "./search-cache.ts";

export type PlanSource = "keyword" | "cache" | "model" | "fallback";

export interface Planned {
  readonly plan: QueryPlan.QueryPlan;
  readonly source: PlanSource;
}

export class QueryPlanner extends Context.Service<
  QueryPlanner,
  {
    readonly plan: (query: string) => Effect.Effect<Planned>;
  }
>()("@stargrep/core/search/query-planner/QueryPlanner") {}

const CachedPlan = Schema.Struct({ plannedOn: Schema.String, output: QueryPlan.PlannerOutput });

const hasDates = ({ filters }: QueryPlan.PlannerOutput) =>
  filters.starredAfter !== null || filters.starredBefore !== null;

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const cache = yield* SearchCache.SearchCache;
  const plans = SearchCache.entry({
    namespace: `plan/${textGeneration.model}/${PlannerPrompt.version}`,
    schema: CachedPlan,
    ttl: SearchCache.stableTtl,
  });

  const plan = Effect.fn("QueryPlanner.plan")(function* (typed: string) {
    const query = QueryPlan.normalize(typed);
    const kind = QueryPlan.queryKind(query);
    if (kind !== "sentence") return { plan: QueryPlan.asTyped(query, kind), source: "keyword" } satisfies Planned;

    const now = yield* DateTime.now;
    const today = DateTime.formatIsoDate(now);
    const key = query.toLowerCase();
    const cached = Option.filter(
      yield* cache.lookup(plans, key),
      (hit) => hit.plannedOn === today || !hasDates(hit.output),
    );
    if (Option.isSome(cached)) {
      return { plan: QueryPlan.fromPlannerOutput(query, cached.value.output), source: "cache" } satisfies Planned;
    }

    return yield* textGeneration
      .generate({
        schema: PlannerPrompt.schema,
        system: PlannerPrompt.system,
        prompt: PlannerPrompt.prompt({ today, query }),
      })
      .pipe(
        Effect.tap((output) => cache.store(plans, key, { plannedOn: today, output })),
        Effect.map((output): Planned => ({ plan: QueryPlan.fromPlannerOutput(query, output), source: "model" })),
        Effect.catch((error) =>
          Effect.logWarning("Query planner failed, searching the query as typed", { error: error._tag }).pipe(
            Effect.as<Planned>({ plan: QueryPlan.asTyped(query, kind), source: "fallback" }),
          ),
        ),
      );
  });

  return QueryPlanner.of({ plan });
});

export const layer = Layer.effect(QueryPlanner, make);
