import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiOutputInvalid } from "@stargrep/ai/errors";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch, Float32Vector } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import { everything, type Selection } from "@stargrep/knowledge/atom";
import { SubjectId } from "@stargrep/knowledge/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Compile from "./compile.ts";
import { type MetricId, registry } from "./metric-registry.ts";
import * as ModelAllowance from "./model-allowance.ts";
import type * as QueryPlan from "./query-plan.ts";
import * as QueryPlanner from "./query-planner.ts";
import * as SearchCache from "./search-cache.ts";
import * as Spelling from "./spelling.ts";

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

// A filter named a subject that does not exist, is private, or was rejected. It is never dropped silently.
export class FacetUnavailable extends Schema.TaggedError<FacetUnavailable, { readonly brand: unique symbol }>()(
  "FacetUnavailable",
  {
    subjects: Schema.Array(SubjectId),
  },
) {
  override get message(): string {
    return `No public subject has the ID ${this.subjects.join(", ")}`;
  }
}

export type SearchError =
  | AccountNotSynced
  | AiError
  | DbQueryFailed
  | DbRowInvalid
  | EmbeddingModelMismatch
  | FacetUnavailable
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
  // Atoms the caller chose, which always filter. Everything when absent.
  readonly filter?: Selection;
}

export interface MetricValue {
  readonly metric: MetricId;
  readonly value: number | null;
}

export interface SearchResult {
  readonly repo: Db.SearchHit["repo"];
  readonly nameMatch: boolean;
  // Found because the typed words spell its name with one edit at most, after nothing else matched.
  readonly similarName: boolean;
  readonly textRank: number | null;
  readonly vectorRank: number | null;
  readonly metrics: ReadonlyArray<MetricValue>;
}

export interface SearchOutcome {
  readonly plan: QueryPlan.QueryPlan;
  readonly planSource: QueryPlanner.PlanSource;
  readonly results: ReadonlyArray<SearchResult>;
  readonly applied: ReadonlyArray<Compile.AppliedAtom>;
}

interface Found {
  readonly planned: QueryPlanner.Planned;
  readonly results: ReadonlyArray<SearchResult>;
  readonly applied: ReadonlyArray<Compile.AppliedAtom>;
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

// How many repos with a similar name search reads before it orders them by how close the whole name is.
const similarNameCandidates = 50;

const planMetrics = (plan: QueryPlan.QueryPlan): ReadonlyArray<MetricId> => [
  ...new Set([
    ...plan.filters.metrics.map((bound) => bound.metric),
    ...(plan.ranking._tag === "metric" ? [plan.ranking.metric] : []),
  ]),
];

export const reasonLine = (result: SearchResult): string =>
  [
    ...(result.nameMatch ? ["exact name"] : []),
    ...(result.similarName ? ["similar name"] : []),
    ...(result.textRank === null ? [] : [`keyword match #${result.textRank}`]),
    ...(result.vectorRank === null ? [] : [`meaning match #${result.vectorRank}`]),
    ...result.metrics.flatMap(({ metric, value }) => (value === null ? [] : [registry[metric].format(value)])),
  ].join(", ");

export const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const embeddings = yield* Embeddings.Embeddings;
  const cache = yield* SearchCache.SearchCache;
  const planner = yield* QueryPlanner.QueryPlanner;
  const allowance = yield* ModelAllowance.ModelAllowance;
  const vectors = SearchCache.entry({
    namespace: `embedding/${embeddings.model.id}`,
    schema: Float32Vector,
    ttl: SearchCache.stableTtl,
  });

  const embedQuery = Effect.fn("Search.embedQuery")(
    function* (text: string) {
      const cached = yield* cache.lookup(vectors, text);
      if (Option.isSome(cached)) return yield* decodeEmbedding({ model: embeddings.model.id, vector: cached.value });
      yield* allowance.take("embed");
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

  // A query embedding the allowance refuses runs the same plan on full text alone, reported as a fallback, so a plan
  // the model was paid for keeps its filters and ranking.
  const find = Effect.fn("Search.find")(function* (
    scope: Db.SearchScope,
    planned: QueryPlanner.Planned,
    request: SearchRequest,
  ) {
    const embedding = yield* embedQuery(planned.plan.semanticText).pipe(
      Effect.asSome,
      Effect.catchTags({ ModelCallRefused: () => Effect.succeedNone }),
    );
    const ran: QueryPlanner.Planned = Option.isSome(embedding)
      ? planned
      : { plan: planned.plan, source: "fallback", failure: "ModelCallRefused" };
    const metrics = planMetrics(ran.plan);
    const { filters } = ran.plan;
    const compiled = Compile.compileQuery({
      query: ran.plan.textQuery,
      planned: filters,
      explicit: request.filter ?? everything,
      policy: yield* Compile.CurrentPolicy,
    });
    const hybrid = (query: Compile.CompiledQuery) =>
      db.search.hybrid({
        scope,
        text: query.text,
        embedding: Option.getOrNull(embedding),
        maxDistance: embeddings.model.maxMatchDistance,
        limit: request.limit,
        name: ran.plan.exactName,
        metrics: metrics.map((id) => registry[id]),
        filters: {
          archived: filters.archived,
          starredAfter: filters.starredAfter,
          starredBefore: filters.starredBefore,
          metrics: filters.metrics,
        },
        atoms: { explicit: query.explicit, stated: query.stated.map(({ group }) => group) },
        rankBy: ran.plan.ranking._tag === "metric" ? ran.plan.ranking : null,
      });
    let applies = compiled;
    let { hits, resolution } = yield* hybrid(compiled);
    const relaxation = yield* Compile.CurrentRelaxation;
    const loosened = relaxation === null ? null : Compile.relaxed(compiled);
    if (relaxation !== null && loosened !== null && hits.length < Math.min(relaxation.below, request.limit)) {
      const second = yield* hybrid(loosened);
      if (second.hits.length >= Math.min(relaxation.atLeast, request.limit)) {
        applies = loosened;
        ({ hits, resolution } = second);
      }
    }
    if (resolution.unavailable.length > 0) return yield* new FacetUnavailable({ subjects: resolution.unavailable });
    return {
      planned: ran,
      applied: Compile.applied(applies, resolution),
      results: hits.map(
        (hit): SearchResult => ({
          repo: hit.repo,
          nameMatch: hit.nameMatch,
          similarName: false,
          textRank: hit.textRank,
          vectorRank: hit.vectorRank,
          metrics: metrics.map((metric, index) => ({ metric, value: hit.metrics[index] ?? null })),
        }),
      ),
    } satisfies Found;
  });

  // The planner cannot place a little-known name and reads it as the nearest thing it knows, as it reads "hlrags" as
  // RAG, and a misspelled name's meaning is too far from its repo to rank it. So a repo the typed words spell with one
  // edit at most answers first, the closest whole name first. The query does not apply the caller's own filter, so a
  // filtered search goes on to the planner.
  const similarNames = Effect.fn("Search.similarNames")(function* (scope: Db.SearchScope, request: SearchRequest) {
    const typed = Spelling.letters(request.query);
    if (request.filter !== undefined || typed.length < Spelling.shortest) return [];
    const found = yield* db.search.nearNames({ scope, text: request.query, limit: similarNameCandidates });
    return found
      .map((repo) => ({ repo, edits: Spelling.edits(typed, Spelling.letters(repo.name)) }))
      .sort((left, right) => left.edits - right.edits)
      .slice(0, request.limit)
      .map(
        ({ repo }): SearchResult => ({
          repo,
          nameMatch: false,
          similarName: true,
          textRank: null,
          vectorRank: null,
          metrics: [],
        }),
      );
  });

  const outcome = ({ planned, results, applied }: Found) =>
    Metric.update(Metric.withAttributes(plansMade, QueryPlanner.planAttributes(planned)), 1).pipe(
      Effect.as<SearchOutcome>({ plan: planned.plan, planSource: planned.source, results, applied }),
    );

  const search = Effect.fn("Search.search")(function* (request: SearchRequest) {
    const scope = yield* dbScope(request.scope);
    const typed = yield* find(scope, yield* planner.plan(request.query), request);
    if (typed.results.length > 0 || typed.planned.source !== "keyword") return yield* outcome(typed);
    // Typed words that match nothing are often a misspelled name. Words that still match as a prefix are most likely a
    // word the user is still typing, so they stop here. A name the typed words spell with one edit answers next, and the
    // planner reads past any other misspelling.
    const text = typed.planned.plan.textQuery;
    if (yield* db.search.matchesAsPrefix({ scope, text })) return yield* outcome(typed);
    const similar = yield* similarNames(scope, request);
    if (similar.length > 0) return yield* outcome({ ...typed, results: similar });
    const read = yield* planner.planWithModel(request.query);
    if (read.source === "fallback") return yield* outcome({ ...typed, planned: read });
    return yield* outcome(yield* find(scope, read, request));
  });

  return Search.of({ search });
});

export const layer = Layer.effect(Search, make);
