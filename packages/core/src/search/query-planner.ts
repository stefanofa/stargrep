import type { AiError } from "@stargrep/ai/errors";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as PlannerPrompt from "./planner-prompt.ts";
import * as QueryPlan from "./query-plan.ts";
import * as SearchCache from "./search-cache.ts";

export const PlanSource = Schema.Literals(["keyword", "cache", "model", "fallback"]);
export type PlanSource = typeof PlanSource.Type;

export type Planned =
  | { readonly plan: QueryPlan.QueryPlan; readonly source: Exclude<PlanSource, "fallback"> }
  | { readonly plan: QueryPlan.QueryPlan; readonly source: "fallback"; readonly failure: AiError["_tag"] };

export class QueryPlanner extends Context.Service<
  QueryPlanner,
  {
    readonly plan: (query: string) => Effect.Effect<Planned>;
    readonly planWithModel: (query: string) => Effect.Effect<Planned>;
  }
>()("@stargrep/core/search/query-planner/QueryPlanner") {}

export const plansMade = Metric.counter("stargrep_search_plans", {
  description: "Query plans, by source, and by the planner failure that made search fall back to the typed text.",
});

const recordPlan = (planned: Planned) => {
  const attributes: Readonly<Record<string, string>> =
    planned.source === "fallback" ? { source: planned.source, failure: planned.failure } : { source: planned.source };
  return Effect.annotateCurrentSpan(Record.mapKeys(attributes, (key) => `search.plan.${key}`)).pipe(
    Effect.andThen(Metric.update(Metric.withAttributes(plansMade, attributes), 1)),
  );
};

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

  const askModel = Effect.fnUntraced(function* (query: string, kind: QueryPlan.QueryKind) {
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
            Effect.as<Planned>({ plan: QueryPlan.asTyped(query, kind), source: "fallback", failure: error._tag }),
          ),
        ),
      );
  });

  const plan = Effect.fn("QueryPlanner.plan")(function* (typed: string) {
    const query = QueryPlan.normalize(typed);
    const kind = QueryPlan.queryKind(query);
    if (kind !== "sentence") return { plan: QueryPlan.asTyped(query, kind), source: "keyword" } satisfies Planned;
    return yield* askModel(query, kind);
  }, Effect.tap(recordPlan));

  const planWithModel = Effect.fn("QueryPlanner.planWithModel")(function* (typed: string) {
    const query = QueryPlan.normalize(typed);
    return yield* askModel(query, QueryPlan.queryKind(query));
  }, Effect.tap(recordPlan));

  return QueryPlanner.of({ plan, planWithModel });
});

export const layer = Layer.effect(QueryPlanner, make);
