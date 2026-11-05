import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiOutputInvalid } from "@stargrep/ai/errors";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch, Float32Vector } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type MetricId, registry } from "./metric-registry.ts";
import type * as QueryPlan from "./query-plan.ts";
import * as QueryPlanner from "./query-planner.ts";
import * as SearchCache from "./search-cache.ts";
import * as Vocabulary from "./vocabulary.ts";

export class SearchScopeUnavailable extends Schema.TaggedError<
  SearchScopeUnavailable,
  { readonly brand: unique symbol }
>()("SearchScopeUnavailable", {
  scope: Schema.Literals(["network", "global"]),
}) {
  override get message(): string {
    return `Search over '${this.scope}' is not available yet`;
  }
}

export class AccountNotSynced extends Schema.TaggedError<AccountNotSynced, { readonly brand: unique symbol }>()(
  "AccountNotSynced",
  {
    login: Schema.String,
  },
) {
  override get message(): string {
    return `Stargrep has no account for login '${this.login}'`;
  }
}

export type SearchError =
  | AccountNotSynced
  | AiError
  | DbQueryFailed
  | DbRowInvalid
  | EmbeddingModelMismatch
  | SearchScopeUnavailable;

export const ScopeKind = Schema.Literals(["stars", "network", "global"]);
export type ScopeKind = typeof ScopeKind.Type;

export type Scope =
  | { readonly _tag: Exclude<ScopeKind, "global">; readonly login: Login }
  | { readonly _tag: "global" };

export interface SearchRequest {
  readonly scope: Scope;
  readonly query: string;
  readonly limit: number;
}

export interface MetricValue {
  readonly metric: MetricId;
  readonly value: number | null;
}

export interface SearchResult {
  readonly repo: Db.SearchHit["repo"];
  readonly nameMatch: boolean;
  readonly textRank: number | null;
  readonly vectorRank: number | null;
  readonly metrics: ReadonlyArray<MetricValue>;
}

export interface SearchOutcome {
  readonly plan: QueryPlan.QueryPlan;
  readonly planSource: QueryPlanner.PlanSource;
  readonly results: ReadonlyArray<SearchResult>;
}

export class Search extends Context.Service<
  Search,
  {
    readonly search: (request: SearchRequest) => Effect.Effect<SearchOutcome, SearchError>;
  }
>()("@stargrep/core/search/search") {}

export const plansMade = Metric.counter("stargrep_search_plans", {
  description:
    "Searches, by the source of the plan each one ran, and by the planner failure that made search fall back to the typed text.",
});

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const planMetrics = (plan: QueryPlan.QueryPlan): ReadonlyArray<MetricId> => [
  ...new Set([
    ...plan.filters.metrics.map((bound) => bound.metric),
    ...(plan.ranking._tag === "metric" ? [plan.ranking.metric] : []),
  ]),
];

export const reasonLine = (result: SearchResult): string =>
  [
    ...(result.nameMatch ? ["exact name"] : []),
    ...(result.textRank === null ? [] : [`keyword match #${result.textRank}`]),
    ...(result.vectorRank === null ? [] : [`meaning match #${result.vectorRank}`]),
    ...result.metrics.flatMap(({ metric, value }) => (value === null ? [] : [registry[metric].format(value)])),
  ].join(", ");

export const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const embeddings = yield* Embeddings.Embeddings;
  const cache = yield* SearchCache.SearchCache;
  const planner = yield* QueryPlanner.QueryPlanner;
  const vectors = SearchCache.entry({
    namespace: `embedding/${embeddings.model.id}`,
    schema: Float32Vector,
    ttl: SearchCache.stableTtl,
  });

  const embedQuery = Effect.fn("Search.embedQuery")(
    function* (text: string) {
      const cached = yield* cache.lookup(vectors, text);
      if (Option.isSome(cached)) return yield* decodeEmbedding({ model: embeddings.model.id, vector: cached.value });
      const [fresh] = yield* embeddings.embed([text]);
      const embedding = yield* decodeEmbedding({ model: embeddings.model.id, vector: fresh?.vector ?? [] });
      yield* cache.store(vectors, text, embedding.vector);
      return embedding;
    },
    Effect.catchTags({
      SchemaError: () =>
        Effect.fail(
          new AiOutputInvalid({
            operation: "embed",
            model: embeddings.model.id,
            detail: "the query vector does not fit the database column",
          }),
        ),
    }),
  );

  const dbScope = Effect.fn("Search.dbScope")(function* (scope: Scope) {
    if (scope._tag !== "stars") return yield* new SearchScopeUnavailable({ scope: scope._tag });
    const account = yield* db.accounts.byLogin(scope.login);
    if (Option.isNone(account)) return yield* new AccountNotSynced({ login: scope.login });
    return { kind: "stars", accountId: account.value.id } satisfies Db.SearchScope;
  });

  const find = Effect.fn("Search.find")(function* (scope: Db.SearchScope, plan: QueryPlan.QueryPlan, limit: number) {
    const metrics = planMetrics(plan);
    const hits = yield* db.search.hybrid({
      scope,
      text: plan.textQuery,
      embedding: yield* embedQuery(plan.semanticText),
      maxDistance: embeddings.model.maxMatchDistance,
      limit,
      name: plan.exactName,
      metrics: metrics.map((id) => registry[id]),
      filters: { ...plan.filters, languages: Vocabulary.matchNames(plan.filters.languages) },
      rankBy: plan.ranking._tag === "metric" ? plan.ranking : null,
    });
    return hits.map(
      (hit): SearchResult => ({
        repo: hit.repo,
        nameMatch: hit.nameMatch,
        textRank: hit.textRank,
        vectorRank: hit.vectorRank,
        metrics: metrics.map((metric, index) => ({ metric, value: hit.metrics[index] ?? null })),
      }),
    );
  });

  const outcome = (planned: QueryPlanner.Planned, results: ReadonlyArray<SearchResult>) =>
    Metric.update(Metric.withAttributes(plansMade, QueryPlanner.planAttributes(planned)), 1).pipe(
      Effect.as<SearchOutcome>({ plan: planned.plan, planSource: planned.source, results }),
    );

  const search = Effect.fn("Search.search")(function* (request: SearchRequest) {
    const scope = yield* dbScope(request.scope);
    const typed = yield* planner.plan(request.query);
    const results = yield* find(scope, typed.plan, request.limit);
    if (results.length > 0 || typed.source !== "keyword") return yield* outcome(typed, results);
    // Typed words that match nothing are often a misspelled name, which the planner can read past. Words that still
    // match as a prefix are most likely a word the user is still typing, so they skip the planner.
    if (yield* db.search.matchesAsPrefix({ scope, text: typed.plan.textQuery })) return yield* outcome(typed, results);
    const read = yield* planner.planWithModel(request.query);
    if (read.source === "fallback") return yield* outcome(read, results);
    return yield* outcome(read, yield* find(scope, read.plan, request.limit));
  });

  return Search.of({ search });
});

export const layer = Layer.effect(Search, make);
