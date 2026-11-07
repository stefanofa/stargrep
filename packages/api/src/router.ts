import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { implement } from "@orpc/server";
import { MetricRegistry, QueryPlan, type QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import { loginKey } from "@stargrep/github/login";
import type { Login } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { type AnswerContext, type AnswerPolicy, answerCache } from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import {
  contract,
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
import { NotSignedIn, requestOwnerSync, type Viewer, type ViewerError, Viewers } from "./viewers.ts";

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

const repoFields = (repo: Db.Repo, icons: IconHost["Service"]) => ({
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

const libraryRepo = (entry: Db.LibraryEntry, icons: IconHost["Service"]) => ({
  ...repoFields(entry.repo, icons),
  keywords: entry.repo.keywords,
  starredAt: DateTime.formatIso(entry.starredAt),
  stars: entry.stars,
  read: entry.read,
});

const searchAnswer = Effect.fnUntraced(function* (input: typeof SearchInput.Type) {
  const scope: Search.Scope = { _tag: input.scope.kind, login: input.scope.login };
  const outcome = yield* (yield* Search.Search).search({ scope, query: input.q, limit: input.limit }).pipe(
    // The contract only accepts stars; a service rejecting that scope violates its contract.
    Effect.catchTags({ SearchScopeUnavailable: Effect.die }),
  );
  const icons = yield* IconHost;
  return {
    planSource: outcome.planSource,
    results: outcome.results.map((result) => ({
      ...repoFields(result.repo, icons),
      reason: Search.reasonLine(result),
      rankedBy: result.metrics.flatMap(({ metric, value }) =>
        value === null ? [] : [MetricRegistry.registry[metric].format(value)],
      ),
      metrics: result.metrics,
    })),
  };
});

// A planner failure answers with the words as typed, so that answer is never kept for the next visitor.
const searchAnswers: AnswerPolicy<typeof SearchOutput.Encoded> = {
  procedure: "search",
  json: Schema.fromJsonString(Schema.toEncoded(SearchOutput)),
  fresh: Duration.minutes(5),
  stale: Duration.days(1),
  keep: (answer) => answer.planSource !== "fallback",
};

// Only the demo account's own stars are cached, so the landing page answers without building any service.
const demoSearchKey = (input: typeof SearchInput.Type, config: PublicConfig) => {
  const login = loginKey(input.scope.login);
  return login === loginKey(config.demoLogin)
    ? Option.some(`search/${login}/${input.scope.kind}/${input.limit}/${QueryPlan.normalize(input.q).toLowerCase()}`)
    : Option.none();
};

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
};

const encodeCursor = Schema.encodeSync(StarsCursor);

// Stars are read and cached in pages of 100 or 1,000, so a client cannot miss the cache by asking for another limit.
const pageSizeFor = (limit: number) => (limit <= 100 ? 100 : maxStarsPage);

const starsPage = Effect.fnUntraced(function* (login: Login, size: number, after: Option.Option<Db.StarsPosition>) {
  const db = yield* Db.Db;
  const account = yield* db.accounts.byLogin(login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login });
  const page = yield* db.stars.page(account.value.id, { limit: size, after });
  const icons = yield* IconHost;
  return {
    login: account.value.login,
    repos: page.entries.map((entry) => libraryRepo(entry, icons)),
    nextCursor: Option.getOrNull(Option.map(page.next, encodeCursor)),
  };
});

// Answers the first limit repos of a page, and continues after the last one answered.
const firstOf = (page: typeof PublicStars.Encoded, limit: number): typeof PublicStars.Encoded => {
  const last = page.repos[limit - 1];
  if (page.repos.length <= limit || last === undefined) return page;
  return {
    ...page,
    repos: page.repos.slice(0, limit),
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

  triggerSync: withServices.triggerSync.use(admission("sync")).effect(function* ({
    input,
  }): ApiResult<"triggerSync", typeof SyncStatus.Type> {
    const { key } = yield* Caller;
    // A session that cannot be read still imports, as a signed-out request.
    const signedIn = yield* (yield* Viewers).signedIn.pipe(Effect.orElseSucceed(Option.none));
    const by: SyncRequests.Requester = Option.match(signedIn, {
      onNone: () => ({ _tag: "anyone", caller: key }),
      onSome: (userId) => ({ _tag: "signed-in", userId, caller: key }),
    });
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

  // The page reads syncStatus only after viewer answers, so a sync claimed here is already queued when it looks.
  viewer: withServices.viewer.effect(function* ({ context }): ApiResult<"viewer", typeof WireViewer.Type> {
    const { userId, account } = yield* context.viewer;
    yield* requestOwnerSync(account.login, userId, "library open");
    return {
      login: account.login,
      name: account.name,
      avatarUrl: account.avatarUrl,
      starredCount: account.starredCount,
    };
  }),

  library: withServices.library.effect(function* ({ context }): ApiResult<"library", typeof Library.Type> {
    const { account } = yield* context.viewer;
    const entries = yield* (yield* Db.Db).stars.library(account.id);
    const icons = yield* IconHost;
    return { repos: entries.map((entry) => libraryRepo(entry, icons)) };
  }),

  stars: os.stars
    .use(starsResponse)
    .use(starsCache)
    .use(Services.services)
    .use(admission("stars"))
    .effect(function* ({ input }): ApiResult<"stars", typeof PublicStars.Type> {
      return yield* starsPage(input.login, pageSizeFor(input.limit), Option.fromUndefinedOr(input.cursor));
    }),

  config: os.config.handler(({ context }) => {
    context.resHeaders?.set("cache-control", "public, max-age=300");
    return context.publicConfig;
  }),

  getRepo: withServices.getRepo.effect(function* ({ input }): ApiResult<"getRepo", typeof RepoDetail.Type> {
    return yield* Effect.all([Db.Db.use((db) => db.repos.require(input.id)), IconHost]).pipe(
      Effect.map(([repo, icons]) => ({
        ...repoFields(repo, icons),
        keywords: repo.keywords,
        homepage: repo.homepage,
        createdAt: iso(repo.createdAt),
      })),
    );
  }),
});
