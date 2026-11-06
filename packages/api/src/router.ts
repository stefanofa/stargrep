import "@orpc/effect/extensions/effect";
import type { WithEffectContext } from "@orpc/effect";
import { implement } from "@orpc/server";
import { MetricRegistry, QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type AnswerContext, type AnswerPolicy, cachedAnswer } from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import {
  contract,
  maxStarsPage,
  type PublicConfig,
  PublicStars,
  type RepoInput,
  type SearchInput,
  SearchOutput,
  StarsCursor,
  type SyncInput,
} from "./contract.ts";
import { errorStatus, type WireCode, wireError } from "./errors.ts";
import { IconHost, iconUrl } from "./icon-host.ts";
import { instrumentation, type ProcedureTime, type Transport } from "./middleware/instrumentation.ts";
import { type RateLimited, RateLimiter, type RateLimiterUnavailable, type RateLimitKind } from "./rate-limiter.ts";
import type { ApiServices, ApiServicesUnavailable } from "./services.ts";
import * as Services from "./services.ts";
import { requestOwnerSync, type ViewerError, Viewers } from "./viewers.ts";

export interface ApiContext extends WithEffectContext<never>, AnswerContext {
  readonly transport: Transport;
  readonly publicConfig: PublicConfig;
  readonly procedureTime: ProcedureTime;
}

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

const toWire = (traceId: string) => (error: ApiFailure) => {
  const code = wireCodes[error._tag];
  const failure = Effect.fail(wireError(code, traceId));
  return errorStatus[code] < 500
    ? failure
    : Effect.logError("API call failed", { error: error._tag, detail: error.message, traceId }).pipe(
        Effect.andThen(failure),
      );
};

type HandlerContext = ApiContext & { readonly traceId: string };

// Builds the request's services only when a procedure runs, after oRPC has validated its input.
const withServices = <A>(context: HandlerContext, run: Effect.Effect<A, ApiFailure, ApiServices>) =>
  Services.withServices(context.services, run).pipe(Effect.catch(toWire(context.traceId)));

const handle = <I, O>(run: (input: I) => Effect.Effect<O, ApiFailure, ApiServices>) =>
  function* ({ input, context }: { readonly input: I; readonly context: HandlerContext }) {
    return yield* withServices(context, run(input));
  };

const cached = <A>(
  context: HandlerContext,
  policy: AnswerPolicy<A>,
  key: string,
  compute: Effect.Effect<A, ApiFailure, ApiServices>,
  admit: Effect.Effect<void, ApiFailure, ApiServices>,
) => cachedAnswer(context, policy, key, compute, admit).pipe(Effect.catch(toWire(context.traceId)));

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
  const scope: Search.Scope = input.scope === "global" ? { _tag: "global" } : { _tag: input.scope, login: input.login };
  const outcome = yield* (yield* Search.Search).search({ scope, query: input.q, limit: input.limit });
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
const searchAnswers: AnswerPolicy<typeof SearchOutput.Type> = {
  procedure: "search",
  json: Schema.fromJsonString(SearchOutput),
  fresh: Duration.minutes(5),
  stale: Duration.days(1),
  keep: (answer) => answer.planSource !== "fallback",
};

// Only the demo account's own stars are cached, so the landing page answers without building any service.
const demoSearchKey = (input: typeof SearchInput.Type, config: PublicConfig) => {
  const login = input.login.toLowerCase();
  return input.scope === "stars" && login === config.demoLogin.toLowerCase()
    ? Option.some(`search/${login}/${input.scope}/${input.limit}/${QueryPlan.normalize(input.q).toLowerCase()}`)
    : Option.none();
};

const admit = (kind: RateLimitKind) => RateLimiter.use((limiter) => limiter.acquire(kind));

const starsAnswers: AnswerPolicy<typeof PublicStars.Type> = {
  procedure: "stars",
  json: Schema.fromJsonString(PublicStars),
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
const firstOf = (page: typeof PublicStars.Type, limit: number): typeof PublicStars.Type => {
  const last = page.repos[limit - 1];
  if (page.repos.length <= limit || last === undefined) return page;
  return {
    ...page,
    repos: page.repos.slice(0, limit),
    nextCursor: encodeCursor({ starredAt: DateTime.makeUnsafe(last.starredAt), repoId: last.id }),
  };
};

const syncStatus =
  (login: Login) =>
  ([status, enrichment]: readonly [SyncRequests.SyncStatus, Db.EnrichmentProgress]) => ({
    login,
    state: status.state,
    requestedAt: status.state === "unknown" || status.state === "done" ? null : iso(status.requestedAt),
    syncedAt: status.state === "unknown" ? null : iso(status.syncedAt),
    waiting: status.state === "waiting" ? { ahead: status.ahead, startsAt: DateTime.formatIso(status.startsAt) } : null,
    starredTotal: status.starredTotal,
    accountType: status.accountType,
    enrichment,
  });

const withProgress = <E, R>(login: Login, status: Effect.Effect<SyncRequests.SyncStatus, E, R>) =>
  Effect.all([status, Db.Db.use((db) => db.stars.enrichment(login))], { concurrency: 2 }).pipe(
    Effect.map(syncStatus(login)),
  );

const implementer = implement(contract).$context<ApiContext>();
const os = implementer.use(instrumentation);

export const router = implementer.router({
  search: os.search.effect(function* ({ input, context }) {
    return yield* Option.match(demoSearchKey(input, context.publicConfig), {
      onNone: () => withServices(context, Effect.andThen(admit("search"), searchAnswer(input))),
      onSome: (key) => cached(context, searchAnswers, key, searchAnswer(input), admit("search")),
    });
  }),

  triggerSync: os.triggerSync.effect(
    handle((input: typeof SyncInput.Type) =>
      Effect.gen(function* () {
        yield* admit("sync");
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
    ),
  ),

  syncStatus: os.syncStatus.effect(
    handle((input: typeof SyncInput.Type) =>
      withProgress(
        input.login,
        SyncRequests.SyncRequests.use((requests) => requests.status(input.login)),
      ),
    ),
  ),

  // The page reads syncStatus only after viewer answers, so a sync claimed here is already queued when it looks.
  viewer: os.viewer.effect(
    handle(() =>
      Effect.gen(function* () {
        const { userId, account } = yield* (yield* Viewers).current;
        yield* requestOwnerSync(account.login, userId, "library open");
        return {
          login: account.login,
          name: account.name,
          avatarUrl: account.avatarUrl,
          starredCount: account.starredCount,
        };
      }),
    ),
  ),

  library: os.library.effect(
    handle(() =>
      Effect.gen(function* () {
        const { account } = yield* (yield* Viewers).current;
        const entries = yield* (yield* Db.Db).stars.library(account.id);
        const icons = yield* IconHost;
        return { repos: entries.map((entry) => libraryRepo(entry, icons)) };
      }),
    ),
  ),

  stars: os.stars.effect(function* ({ input, context }) {
    const size = pageSizeFor(input.limit);
    const after = Option.fromUndefinedOr(input.cursor);
    const key = `stars/${input.login.toLowerCase()}/${size}/${Option.match(after, { onNone: () => "", onSome: encodeCursor })}`;
    const page = yield* cached(context, starsAnswers, key, starsPage(input.login, size, after), admit("stars"));
    context.resHeaders?.set("cache-control", "public, max-age=10");
    return firstOf(page, input.limit);
  }),

  config: os.config.handler(({ context }) => {
    context.resHeaders?.set("cache-control", "public, max-age=300");
    return context.publicConfig;
  }),

  getRepo: os.getRepo.effect(
    handle((input: typeof RepoInput.Type) =>
      Effect.all([Db.Db.use((db) => db.repos.require(input.id)), IconHost]).pipe(
        Effect.map(([repo, icons]) => ({
          ...repoFields(repo, icons),
          keywords: repo.keywords,
          homepage: repo.homepage,
          createdAt: iso(repo.createdAt),
        })),
      ),
    ),
  ),
});
