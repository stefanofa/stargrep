import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
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

export const plansMade = Metric.counter("stargrep_search_plans", {
  description: "Query plans, by source, and by the planner failure that made search fall back to the typed text.",
});

const recordPlan = (planned: Planned, failure?: string) =>
  Effect.annotateCurrentSpan({
    "search.plan_source": planned.source,
    ...(failure === undefined ? {} : { "search.planner_failure": failure }),
  }).pipe(
    Effect.andThen(
      Metric.update(
        Metric.withAttributes(plansMade, { source: planned.source, ...(failure === undefined ? {} : { failure }) }),
        1,
      ),
    ),
    Effect.as(planned),
  );

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
    if (kind !== "sentence") return yield* recordPlan({ plan: QueryPlan.asTyped(query, kind), source: "keyword" });

    const now = yield* DateTime.now;
    const today = DateTime.formatIsoDate(now);
    const key = query.toLowerCase();
    const cached = Option.filter(
      yield* cache.lookup(plans, key),
      (hit) => hit.plannedOn === today || !hasDates(hit.output),
    );
    if (Option.isSome(cached)) {
      return yield* recordPlan({ plan: QueryPlan.fromPlannerOutput(query, cached.value.output), source: "cache" });
    }

    return yield* textGeneration
      .generate({
        schema: PlannerPrompt.schema,
        system: PlannerPrompt.system,
        prompt: PlannerPrompt.prompt({ today, query }),
      })
      .pipe(
        Effect.tap((output) => cache.store(plans, key, { plannedOn: today, output })),
        Effect.flatMap((output) => recordPlan({ plan: QueryPlan.fromPlannerOutput(query, output), source: "model" })),
        Effect.catch((error) =>
          Effect.logWarning("Query planner failed, searching the query as typed", { error: error._tag }).pipe(
            Effect.andThen(recordPlan({ plan: QueryPlan.asTyped(query, kind), source: "fallback" }, error._tag)),
          ),
        ),
      );
  });

  return QueryPlanner.of({ plan });
});

export const layer = Layer.effect(QueryPlanner, make);
