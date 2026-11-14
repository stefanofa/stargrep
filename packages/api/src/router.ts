import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { implement } from "@orpc/server";
import { MetricRegistry, QueryPlan, type QueryPlanner, Search } from "@stargrep/core/search";
import { OwnerAccount, SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import { loginKey } from "@stargrep/github/login";
import type { Login } from "@stargrep/github/schemas";
import { everything, normalize, SelectionKey } from "@stargrep/knowledge/atom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { type AnswerContext, type AnswerPolicy, answerCache, searchWindows } from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import {
  type AppliedAtom,
  contract,
  type FacetMatches,
  type IconPlate,
  type Library,
  type MetricId,
  type maxIconSize,
  maxStarsPage,
  type OwnerType,
  type PlanSource,
  type PublicConfig,
  PublicStars,
  type RepoDetail,
  RepoId,
  requiresSession,
  type SearchInput,
  SearchOutput,
  StarsCursor,
  type StarsInput,
  type SyncStatus,
  type Viewer as WireViewer,
} from "./contract.ts";
import { errorStatus, type WireCode, wireError } from "./errors.ts";
import { IconHost, iconUrl } from "./icon-host.ts";
import { instrumentation, type ProcedureTime, type Transport } from "./middleware/instrumentation.ts";
import { type RateLimited, RateLimiter, type RateLimiterUnavailable, type RateLimitKind } from "./rate-limiter.ts";
import type { ApiServices, ApiServicesUnavailable } from "./services.ts";
import * as Services from "./services.ts";
import { NotSignedIn, type Viewer, type ViewerError, Viewers } from "./viewers.ts";

export interface ApiContext extends WithEffectContext<never>, AnswerContext {
  readonly transport: Transport;
  readonly publicConfig: PublicConfig;
  readonly procedureTime: ProcedureTime;
  readonly serviceLayer: Layer.Layer<ApiServices, ApiServicesUnavailable>;
}

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies Equals<typeof MetricId.Type, MetricRegistry.MetricId>;
true satisfies Equals<typeof PlanSource.Type, QueryPlanner.PlanSource>;
true satisfies Equals<typeof IconPlate.Type, Db.IconPlate>;
true satisfies Equals<typeof maxIconSize, typeof Db.maxIconSize>;
true satisfies Equals<typeof OwnerType.Type, Db.OwnerType>;
true satisfies Equals<(typeof SyncStatus.Type)["state"], SyncRequests.SyncStatus["state"]>;
true satisfies Equals<typeof AppliedAtom.Type, Search.SearchOutcome["applied"][number]>;

type ApiFailure =
  | Search.SearchError
  | SyncRequests.SyncRequestError
  | RepoNotFound
  | DbQueryFailed
  | DbRowInvalid
  | RateLimited
  | RateLimiterUnavailable
  | ViewerError
  | ApiServicesUnavailable;

const wireCodes = {
  NotSignedIn: "UNAUTHORIZED",
  AccountNotSynced: "ACCOUNT_NOT_SYNCED",
  LoginNotFound: "LOGIN_NOT_FOUND",
  RepoNotFound: "REPO_NOT_FOUND",
  SearchScopeUnavailable: "SCOPE_UNAVAILABLE",
  FacetUnavailable: "BAD_REQUEST",
  RateLimited: "TOO_MANY_REQUESTS",
  NewAccountLimited: "TOO_MANY_REQUESTS",
  SyncBusy: "SYNC_BUSY",
  AiKeyMissing: "SERVICE_UNAVAILABLE",
  AiRequestFailed: "SERVICE_UNAVAILABLE",
  AiTimeout: "SERVICE_UNAVAILABLE",
  AiUnavailable: "SERVICE_UNAVAILABLE",
  ApiServicesUnavailable: "SERVICE_UNAVAILABLE",
  DbQueryFailed: "SERVICE_UNAVAILABLE",
  OwnerLookupFailed: "SERVICE_UNAVAILABLE",
  RateLimiterUnavailable: "SERVICE_UNAVAILABLE",
  SyncQueueFailed: "SERVICE_UNAVAILABLE",
  ViewerUnavailable: "SERVICE_UNAVAILABLE",
  AiModelNotFound: "INTERNAL_SERVER_ERROR",
  AiOutputInvalid: "INTERNAL_SERVER_ERROR",
  AiRefused: "INTERNAL_SERVER_ERROR",
  DbRowInvalid: "INTERNAL_SERVER_ERROR",
  EmbeddingModelMismatch: "INTERNAL_SERVER_ERROR",
} satisfies Record<ApiFailure["_tag"], WireCode>;

// oRPC erases handler failures. api-handler-errors.grit requires this bound before that boundary.
type Procedure = keyof typeof contract;
type AllowedTag<P extends Procedure> = {
  [Tag in keyof typeof wireCodes]: (typeof wireCodes)[Tag] extends keyof (typeof contract)[P]["~orpc"]["errorMap"]
    ? Tag
    : never;
}[keyof typeof wireCodes];
type ApiResult<P extends Procedure, A> = Effect.fn.Return<
  A,
  Extract<ApiFailure, { readonly _tag: AllowedTag<P> }>,
  ApiServices
>;

const isFailureTag = Schema.is(Schema.Literals(Record.keys(wireCodes)));

// A failure the API answers with a 4xx says the request itself has no answer, so a cached one must not stand in for it.
const refusesRequest = (error: unknown) =>
  Predicate.isObject(error) && "_tag" in error && isFailureTag(error._tag) && errorStatus[wireCodes[error._tag]] < 500;
const wireErrors = middlewareGen<{ readonly traceId: string }>(function* ({ context, next }) {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC types every downstream failure as unknown.
  return yield* next().pipe(
    Effect.catch((error) => {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
      if (!Predicate.isObject(error) || !("_tag" in error) || !isFailureTag(error._tag)) return Effect.fail(error);
      const code = wireCodes[error._tag];
      const failure = Effect.fail(wireError(code, context.traceId));
      return errorStatus[code] < 500
        ? failure
        : Effect.logError("API call failed", {
            error: error._tag,
            detail: "message" in error && typeof error.message === "string" ? error.message : undefined,
            traceId: context.traceId,
          }).pipe(Effect.andThen(failure));
    }),
  );
});

// Public handlers receive a failing effect so reading a viewer also requires declaring session metadata.
const session = middlewareGen<WithEffectContext<ApiServices>, { readonly viewer: Effect.Effect<Viewer, NotSignedIn> }>(
  function* ({ procedure, next }) {
    const viewer: Effect.Effect<Viewer, NotSignedIn> = requiresSession(procedure)
      ? Effect.succeed(yield* (yield* Viewers).current)
      : Effect.fail(new NotSignedIn());
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    return yield* next({ context: { viewer } });
  },
);

const iso = (time: DateTime.Utc | null) => (time === null ? null : DateTime.formatIso(time));

const repoBase = (repo: Db.Repo, icons: IconHost["Service"]) => ({
  id: repo.id,
  owner: repo.owner,
  name: repo.name,
  url: `https://github.com/${repo.owner}/${repo.name}`,
  description: repo.description,
  summary: repo.summary,
  language: repo.language,
  topics: repo.topics,
  license: repo.license,
  kind: repo.kind,
  archived: repo.archived,
  pushedAt: iso(repo.pushedAt),
  icon: repo.icon && { url: iconUrl(icons, repo.icon.key), plate: repo.icon.plate, size: repo.icon.size },
  ownerType: repo.ownerType,
  ownerAvatarUrl: repo.ownerAvatarUrl,
});

const heldFacets = (ids: ReadonlyArray<Db.Repo["id"]>) => Db.Db.use((db) => db.facets.held(ids));

const repoFields = (
  repo: Db.Repo,
  icons: IconHost["Service"],
  held: ReadonlyMap<Db.Repo["id"], ReadonlyArray<Db.HeldAtom>>,
) => ({
  ...repoBase(repo, icons),
  facets: held.get(repo.id) ?? [],
});

// A library lists the keys its chips count and names each key once, in labels.
const libraryRepos = Effect.fnUntraced(function* (entries: ReadonlyArray<Db.LibraryEntry>) {
  const { atoms, labels } = yield* (yield* Db.Db).facets.matching(entries.map((entry) => entry.repo.id));
  const icons = yield* IconHost;
  return {
    repos: entries.map((entry) => ({
      ...repoBase(entry.repo, icons),
      atoms: atoms.get(entry.repo.id) ?? [],
      keywords: entry.repo.keywords,
      starredAt: DateTime.formatIso(entry.starredAt),
      stars: entry.stars,
      read: entry.read,
    })),
    labels,
  };
});

// Sorted and without repeats, so every request for the same atoms gets the answer the cache would give it.
const filterOf = (input: typeof SearchInput.Type) => normalize(input.filter ?? everything);

const searchAnswer = Effect.fnUntraced(function* (input: typeof SearchInput.Type) {
  const scope: Search.Scope = { _tag: input.scope.kind, login: input.scope.login };
  const outcome = yield* (yield* Search.Search)
    .search({ scope, query: input.q, limit: input.limit, filter: filterOf(input) })
    .pipe(
      // The contract only accepts stars, so this failure violates the service's contract.
      Effect.catchTags({ SearchScopeUnavailable: Effect.die }),
    );
  const held = yield* heldFacets(outcome.results.map((result) => result.repo.id));
  const icons = yield* IconHost;
  return {
    planSource: outcome.planSource,
    results: outcome.results.map((result) => ({
      ...repoFields(result.repo, icons, held),
      reason: Search.reasonLine(result),
      rankedBy: result.metrics.flatMap(({ metric, value }) =>
        value === null ? [] : [MetricRegistry.registry[metric].format(value)],
      ),
      metrics: result.metrics,
    })),
    applied: outcome.applied,
  };
});

// A planner failure answers with the words as typed, so that answer is never kept for the next visitor.
const searchAnswers: AnswerPolicy<typeof SearchOutput.Encoded> = {
  procedure: "search",
  json: Schema.fromJsonString(Schema.toEncoded(SearchOutput)),
  ...searchWindows,
  keep: (answer) => answer.planSource !== "fallback",
  refused: refusesRequest,
};

const encodeSelection = Schema.encodeSync(SelectionKey);

// One answer per login, scope, limit, filter, and query as the plan cache keys it, so a filtered search never receives an
// unfiltered answer.
const answerKey = (input: typeof SearchInput.Type) =>
  [
    "search",
    loginKey(input.scope.login),
    input.scope.kind,
    input.limit,
    encodeSelection(filterOf(input)),
    QueryPlan.normalize(input.q).toLowerCase(),
  ].join("/");

// Only the demo account's own stars are cached, so the landing page answers without building any service.
const demoSearchKey = (input: typeof SearchInput.Type, config: PublicConfig) =>
  loginKey(input.scope.login) === loginKey(config.demoLogin) ? Option.some(answerKey(input)) : Option.none();

const admission = (kind: RateLimitKind) =>
  middlewareGen<WithEffectContext<ApiServices> & Pick<AnswerContext, "execution">>(function* ({ context, next }) {
    if (context.execution === "request") yield* (yield* RateLimiter).acquire(kind);
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    return yield* next();
  });

const starsAnswers: AnswerPolicy<typeof PublicStars.Encoded> = {
  procedure: "stars",
  json: Schema.fromJsonString(Schema.toEncoded(PublicStars)),
  fresh: Duration.seconds(10),
  stale: Duration.zero,
  keep: () => true,
  refused: refusesRequest,
};

const encodeCursor = Schema.encodeSync(StarsCursor);

// Stars are read and cached in pages of 100 or 1,000, so a client cannot miss the cache by asking for another limit.
const pageSizeFor = (limit: number) => (limit <= 100 ? 100 : maxStarsPage);

const starsPage = Effect.fnUntraced(function* (login: Login, size: number, after: Option.Option<Db.StarsPosition>) {
  const db = yield* Db.Db;
  const account = yield* db.accounts.byLogin(login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login });
  const page = yield* db.stars.page(account.value.id, { limit: size, after });
  return {
    login: account.value.login,
    ...(yield* libraryRepos(page.entries)),
    nextCursor: Option.getOrNull(Option.map(page.next, encodeCursor)),
  };
});

// Answers the first limit repos of a page, with the labels they use, and continues after the last one answered.
const firstOf = (page: typeof PublicStars.Encoded, limit: number): typeof PublicStars.Encoded => {
  const last = page.repos[limit - 1];
  if (page.repos.length <= limit || last === undefined) return page;
  const repos = page.repos.slice(0, limit);
  const kept = new Set(repos.flatMap((repo) => repo.atoms));
  return {
    ...page,
    repos,
    labels: Object.fromEntries(Object.entries(page.labels).filter(([atom]) => kept.has(atom))),
    nextCursor: encodeCursor({ starredAt: DateTime.makeUnsafe(last.starredAt), repoId: RepoId.make(last.id) }),
  };
};

const syncStatus =
  (login: Login) =>
  ([status, enrichment]: readonly [SyncRequests.SyncStatus, Db.EnrichmentProgress]): typeof SyncStatus.Type => {
    const common = { login, starredTotal: status.starredTotal, accountType: status.accountType, enrichment };
    switch (status.state) {
      case "unknown":
        return { ...common, state: status.state, requestedAt: null, syncedAt: null, waiting: null };
      case "done":
        return {
          ...common,
          state: status.state,
          requestedAt: null,
          syncedAt: DateTime.formatIso(status.syncedAt),
          waiting: null,
        };
      case "waiting":
        return {
          ...common,
          state: status.state,
          requestedAt: DateTime.formatIso(status.requestedAt),
          syncedAt: iso(status.syncedAt),
          waiting: { ahead: status.ahead, startsAt: DateTime.formatIso(status.startsAt) },
        };
      case "queued":
      case "failed":
        return {
          ...common,
          state: status.state,
          requestedAt: DateTime.formatIso(status.requestedAt),
          syncedAt: iso(status.syncedAt),
          waiting: null,
        };
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  };

const withProgress = <E, R>(login: Login, status: Effect.Effect<SyncRequests.SyncStatus, E, R>) =>
  Effect.all([status, Db.Db.use((db) => db.stars.enrichment(login))], { concurrency: 2 }).pipe(
    Effect.map(syncStatus(login)),
  );

const implementer = implement(contract).$context<ApiContext>();
const os = implementer.use(instrumentation).use(wireErrors);
const withServices = os.use(Services.services).use(session);

const searchCache = answerCache(searchAnswers, (input: typeof SearchInput.Type, context: ApiContext) =>
  demoSearchKey(input, context.publicConfig),
);
const starsCache = answerCache(starsAnswers, (input: typeof StarsInput.Type, _context: ApiContext) =>
  Option.some(
    `stars/${loginKey(input.login)}/${pageSizeFor(input.limit)}/${input.cursor === undefined ? "" : encodeCursor(input.cursor)}`,
  ),
);

const starsResponse = middlewareGen<AnswerContext, object, typeof StarsInput.Type, typeof PublicStars.Encoded>(
  function* ({ context, next }, input) {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
    const result = yield* next();
    context.resHeaders?.set("cache-control", "public, max-age=10");
    return { ...result, output: firstOf(result.output, input.limit) };
  },
);

export const router = implementer.router({
  search: os.search
    .use(searchCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"search", typeof SearchOutput.Type> {
      return yield* searchAnswer(input);
    }),

  // The owner's page asks on every open, so a star made on GitHub shows up. Their sync runs on their own token at most
  // once a minute, so it skips the limits that guard the server's token.
  triggerSync: withServices.triggerSync.effect(function* ({
    input,
    context,
  }): ApiResult<"triggerSync", typeof SyncStatus.Type> {
    const { key } = yield* Caller;
    // A session that cannot be read still imports, as a signed-out request.
    const signedIn = yield* (yield* Viewers).signedIn.pipe(Effect.orElseSucceed(Option.none));
    const by = yield* OwnerAccount.requesterOf(input.login, signedIn, key);
    if (by._tag === "owner")
      return yield* withProgress(input.login, OwnerAccount.requestOwnerSync(input.login, by.userId, "page open"));
    if (context.execution === "request") yield* (yield* RateLimiter).acquire("sync");
    return yield* withProgress(
      input.login,
      SyncRequests.SyncRequests.use((requests) => requests.request(input.login, by)),
    );
  }),

  syncStatus: withServices.syncStatus.effect(function* ({ input }): ApiResult<"syncStatus", typeof SyncStatus.Type> {
    return yield* withProgress(
      input.login,
      SyncRequests.SyncRequests.use((requests) => requests.status(input.login)),
    );
  }),

  viewer: withServices.viewer.effect(function* ({ context }): ApiResult<"viewer", typeof WireViewer.Type> {
    const { account } = yield* context.viewer;
    return {
      login: account.login,
      name: account.name,
      avatarUrl: account.avatarUrl,
      starredCount: account.starredCount,
    };
  }),

  library: withServices.library.effect(function* ({ context }): ApiResult<"library", typeof Library.Type> {
    const { account } = yield* context.viewer;
    return yield* libraryRepos(yield* (yield* Db.Db).stars.library(account.id));
  }),

  stars: os.stars
    .use(starsResponse)
    .use(starsCache)
    .use(Services.services)
    .use(admission("stars"))
    .effect(function* ({ input }): ApiResult<"stars", typeof PublicStars.Type> {
      return yield* starsPage(input.login, pageSizeFor(input.limit), Option.fromUndefinedOr(input.cursor));
    }),

  lookupFacets: withServices.lookupFacets.use(admission("search")).effect(function* ({
    input,
  }): ApiResult<"lookupFacets", typeof FacetMatches.Type> {
    return { facets: yield* (yield* Db.Db).facets.lookup({ q: input.q, limit: input.limit }) };
  }),

  config: os.config.handler(({ context }) => {
    context.resHeaders?.set("cache-control", "public, max-age=300");
    return context.publicConfig;
  }),

  getRepo: withServices.getRepo.effect(function* ({ input }): ApiResult<"getRepo", typeof RepoDetail.Type> {
    return yield* Effect.all([Db.Db.use((db) => db.repos.require(input.id)), heldFacets([input.id]), IconHost]).pipe(
      Effect.map(([repo, held, icons]) => ({
        ...repoFields(repo, icons, held),
        keywords: repo.keywords,
        homepage: repo.homepage,
        createdAt: iso(repo.createdAt),
      })),
    );
  }),
});
