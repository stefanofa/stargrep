import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiOutputInvalid } from "@stargrep/ai/errors";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch, Float32Vector } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { GitHubAccountId } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

export type SearchError = AiError | DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch | SearchScopeUnavailable;

export const Scope = Schema.Union([
  Schema.TaggedStruct("stars", { accountId: GitHubAccountId }),
  Schema.TaggedStruct("network", { accountId: GitHubAccountId }),
  Schema.TaggedStruct("global", {}),
]);
export type Scope = typeof Scope.Type;

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

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const dbScope = (scope: Scope): Effect.Effect<Db.SearchScope, SearchScopeUnavailable> =>
  scope._tag === "stars"
    ? Effect.succeed({ kind: "stars", accountId: scope.accountId })
    : Effect.fail(new SearchScopeUnavailable({ scope: scope._tag }));

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

  const search = Effect.fn("Search.search")(function* (request: SearchRequest) {
    const scope = yield* dbScope(request.scope);
    const { plan, source } = yield* planner.plan(request.query);
    const metrics = planMetrics(plan);
    const hits = yield* db.search.hybrid({
      scope,
      text: plan.textQuery,
      embedding: yield* embedQuery(plan.semanticText),
      limit: request.limit,
      name: plan.exactName,
      metrics: metrics.map((id) => registry[id]),
      filters: { ...plan.filters, languages: Vocabulary.matchNames(plan.filters.languages) },
      rankBy: plan.ranking._tag === "metric" ? plan.ranking : null,
    });
    return {
      plan,
      planSource: source,
      results: hits.map(
        (hit): SearchResult => ({
          repo: hit.repo,
          nameMatch: hit.nameMatch,
          textRank: hit.textRank,
          vectorRank: hit.vectorRank,
          metrics: metrics.map((metric, index) => ({ metric, value: hit.metrics[index] ?? null })),
        }),
      ),
    } satisfies SearchOutcome;
  });

  return Search.of({ search });
});

export const layer = Layer.effect(Search, make);
