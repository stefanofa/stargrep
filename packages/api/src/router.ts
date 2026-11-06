import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { implement, ORPCError } from "@orpc/server";
import { MetricRegistry, QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import { type Login, RepoId } from "@stargrep/github/schemas";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AnswerCache } from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import {
  contract,
  type PublicConfig,
  PublicStars,
  type RepoInput,
  type SearchInput,
  SearchOutput,
  type StarsInput,
  type SyncInput,
} from "./contract.ts";
import { errorStatus, type WireCode, wireError } from "./errors.ts";
import { IconHost, iconUrl } from "./icon-host.ts";
import { instrumentation, type ProcedureTime, type Transport } from "./middleware/instrumentation.ts";
import { SearchLimiter, type SearchLimiterUnavailable, type SearchRateLimited } from "./search-limiter.ts";
import { SyncLimiter, type SyncLimiterUnavailable, type SyncRateLimited } from "./sync-limiter.ts";
import { requestOwnerSync, type ViewerError, Viewers } from "./viewers.ts";

export type ApiServices =
  | Db.Db
  | Search.Search
  | SyncRequests.SyncRequests
  | SyncLimiter
  | SearchLimiter
  | Viewers
  | IconHost
  | Caller;

export class ApiServicesUnavailable extends Schema.TaggedError<
  ApiServicesUnavailable,
  { readonly brand: unique symbol }
>()("ApiServicesUnavailable", {
  failure: Schema.String,
}) {
  override get message(): string {
    return `The API services failed to start with ${this.failure}`;
  }
}

export interface ApiContext extends WithEffectContext<never> {
  readonly transport: Transport;
  readonly publicConfig: PublicConfig;
  readonly procedureTime: ProcedureTime;
  readonly services: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>;
  readonly answerCache: AnswerCache;
  // oRPC's ResponseHeadersHandlerPlugin sets this on the HTTP transports.
  readonly resHeaders?: Headers | undefined;
}

type ApiFailure =
  | Search.SearchError
  | SyncRequests.SyncRequestError
  | RepoNotFound
  | DbQueryFailed
  | DbRowInvalid
  | SyncRateLimited
  | SyncLimiterUnavailable
  | SearchRateLimited
  | SearchLimiterUnavailable
  | ViewerError
  | ApiServicesUnavailable;

const wireCodes = {
  NotSignedIn: "UNAUTHORIZED",
  AccountNotSynced: "ACCOUNT_NOT_SYNCED",
  LoginNotFound: "LOGIN_NOT_FOUND",
  RepoNotFound: "REPO_NOT_FOUND",
  SearchScopeUnavailable: "SCOPE_UNAVAILABLE",
  SyncRateLimited: "TOO_MANY_REQUESTS",
  SearchRateLimited: "TOO_MANY_REQUESTS",
  AiSpendLimited: "TOO_MANY_REQUESTS",
  NewAccountLimited: "TOO_MANY_REQUESTS",
  SyncBusy: "SYNC_BUSY",
  AiKeyMissing: "SERVICE_UNAVAILABLE",
  AiRequestFailed: "SERVICE_UNAVAILABLE",
  AiTimeout: "SERVICE_UNAVAILABLE",
  AiUnavailable: "SERVICE_UNAVAILABLE",
  ApiServicesUnavailable: "SERVICE_UNAVAILABLE",
  DbQueryFailed: "SERVICE_UNAVAILABLE",
  OwnerLookupFailed: "SERVICE_UNAVAILABLE",
  SyncLimiterUnavailable: "SERVICE_UNAVAILABLE",
  SearchLimiterUnavailable: "SERVICE_UNAVAILABLE",
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

const handle = <I, O>(run: (input: I) => Effect.Effect<O, ApiFailure, ApiServices>) =>
  function* ({ input, context }: { readonly input: I; readonly context: { readonly traceId: string } }) {
    return yield* run(input).pipe(Effect.catch(toWire(context.traceId)));
  };

const provideServices = middlewareGen<ApiContext & { readonly traceId: string }, WithEffectContext<ApiServices>>(
  function* ({ context, next }) {
    const services = yield* context.services.pipe(Effect.catch(toWire(context.traceId)));
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC types every downstream failure as unknown.
    return yield* next({ context: { "effect/context": Context.merge(context["effect/context"], services) } });
  },
);

type HandlerContext = ApiContext & { readonly traceId: string };

// Builds the request's services only when called, so an answer served from the cache builds none.
const withServices = <A>(context: HandlerContext, run: Effect.Effect<A, ApiFailure, ApiServices>) =>
  context.services.pipe(
    Effect.flatMap((services) => Effect.provideContext(run, services)),
    Effect.catch(toWire(context.traceId)),
  );

type AnswerOutcome = "hit" | "stale" | "miss";

const answersServed = Metric.counter("stargrep_answer_cache", {
  description: "Answers of cached procedures, by procedure and whether the cache served them fresh, stale, or not.",
});

interface AnswerPolicy<A> {
  readonly procedure: "search" | "stars";
  readonly json: Schema.Codec<A, string>;
  // How long a stored answer is served as is.
  readonly fresh: Duration.Duration;
  // How long after that it is still served while a refresh runs.
  readonly stale: Duration.Duration;
  readonly keep: (answer: A) => boolean;
}

const served = (context: HandlerContext, procedure: AnswerPolicy<unknown>["procedure"], outcome: AnswerOutcome) =>
  Effect.andThen(
    Effect.sync(() => context.resHeaders?.set("x-answer-cache", outcome)),
    Metric.update(Metric.withAttributes(answersServed, { procedure, outcome }), 1),
  );

const cachedAnswer = Effect.fnUntraced(function* <A>(
  context: HandlerContext,
  policy: AnswerPolicy<A>,
  key: string,
  compute: Effect.Effect<A, ApiFailure, ApiServices>,
  admit: Effect.Effect<void, ApiFailure, ApiServices> = Effect.void,
) {
  const cache = context.answerCache;
  const keepFor = Duration.sum(policy.fresh, policy.stale);
  const store = (answer: A) =>
    policy.keep(answer)
      ? Schema.encodeEffect(policy.json)(answer).pipe(
          Effect.flatMap((body) => cache.set(key, body, keepFor)),
          Effect.catchTag("SchemaError", () =>
            Effect.logWarning("Answer does not encode", { procedure: policy.procedure }),
          ),
        )
      : Effect.void;

  const stored = yield* cache.get(key);
  if (Option.isSome(stored)) {
    const answer = yield* Effect.option(Schema.decodeEffect(policy.json)(stored.value.body));
    const age = Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - stored.value.storedAt));
    if (Option.isSome(answer) && Duration.isLessThan(age, keepFor)) {
      if (Duration.isLessThan(age, policy.fresh)) {
        yield* served(context, policy.procedure, "hit");
        return answer.value;
      }
      yield* cache.refresh(
        key,
        compute.pipe(
          Effect.flatMap(store),
          Effect.catch((error) =>
            Effect.logWarning("Answer refresh failed", { procedure: policy.procedure, error: error._tag }),
          ),
        ),
      );
      yield* served(context, policy.procedure, "stale");
      return answer.value;
    }
  }
  const answer = yield* withServices(context, Effect.andThen(admit, compute));
  yield* store(answer);
  yield* served(context, policy.procedure, "miss");
  return answer;
});

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

const admitSearch = SearchLimiter.use((limiter) => limiter.acquire);

const starsAnswers: AnswerPolicy<typeof PublicStars.Type> = {
  procedure: "stars",
  json: Schema.fromJsonString(PublicStars),
  fresh: Duration.seconds(10),
  stale: Duration.zero,
  keep: () => true,
};

const StarsCursor = Schema.Struct({ starredAt: Schema.DateTimeUtcFromMillis, repoId: RepoId });

const starsCursor = (position: Db.StarsPosition) => `${DateTime.toEpochMillis(position.starredAt)}-${position.repoId}`;

const starsPosition = (cursor: string | undefined) => {
  if (cursor === undefined) return Option.none<Db.StarsPosition>();
  const [starredAt, repoId] = cursor.split("-").map(Number);
  return Schema.decodeUnknownOption(StarsCursor)({ starredAt, repoId });
};

const starsAnswer = Effect.fnUntraced(function* (
  input: typeof StarsInput.Type,
  after: Option.Option<Db.StarsPosition>,
) {
  const db = yield* Db.Db;
  const account = yield* db.accounts.byLogin(input.login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login: input.login });
  const page = yield* db.stars.page(account.value.id, { limit: input.limit, after });
  const icons = yield* IconHost;
  return {
    login: account.value.login,
    repos: page.entries.map((entry) => libraryRepo(entry, icons)),
    nextCursor: Option.getOrNull(Option.map(page.next, starsCursor)),
  };
});

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
// Router-level middleware such as instrumentation runs before input validation, so a validation error gets a trace ID.
// Procedure-level middleware such as provideServices runs after it, so a bad request never builds the services.
const os = implementer.use(instrumentation);

export const router = implementer.router({
  search: os.search.effect(function* ({ input, context }) {
    return yield* Option.match(demoSearchKey(input, context.publicConfig), {
      onNone: () => withServices(context, Effect.andThen(admitSearch, searchAnswer(input))),
      onSome: (key) => cachedAnswer(context, searchAnswers, key, searchAnswer(input), admitSearch),
    });
  }),

  triggerSync: os.triggerSync.use(provideServices).effect(
    handle((input: typeof SyncInput.Type) =>
      Effect.gen(function* () {
        yield* (yield* SyncLimiter).acquire;
        const { key } = yield* Caller;
        return yield* withProgress(
          input.login,
          SyncRequests.SyncRequests.use((requests) => requests.request(input.login, { _tag: "anyone", caller: key })),
        );
      }),
    ),
  ),

  syncStatus: os.syncStatus.use(provideServices).effect(
    handle((input: typeof SyncInput.Type) =>
      withProgress(
        input.login,
        SyncRequests.SyncRequests.use((requests) => requests.status(input.login)),
      ),
    ),
  ),

  // The page reads syncStatus only after viewer answers, so a sync claimed here is already queued when it looks.
  viewer: os.viewer.use(provideServices).effect(
    handle(() =>
      Effect.gen(function* () {
        const { account } = yield* (yield* Viewers).current;
        yield* requestOwnerSync(account.login, "library open");
        return {
          login: account.login,
          name: account.name,
          avatarUrl: account.avatarUrl,
          starredCount: account.starredCount,
        };
      }),
    ),
  ),

  library: os.library.use(provideServices).effect(
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
    const after = starsPosition(input.cursor);
    if (input.cursor !== undefined && Option.isNone(after)) {
      return yield* Effect.fail(
        new ORPCError("BAD_REQUEST", {
          message: "This cursor does not continue a page of stars.",
          data: { traceId: context.traceId },
        }),
      );
    }
    const key = `stars/${input.login.toLowerCase()}/${input.limit}/${input.cursor ?? ""}`;
    const answer = yield* cachedAnswer(context, starsAnswers, key, starsAnswer(input, after));
    context.resHeaders?.set("cache-control", "public, max-age=10");
    return answer;
  }),

  config: os.config.handler(({ context }) => {
    context.resHeaders?.set("cache-control", "public, max-age=300");
    return context.publicConfig;
  }),

  getRepo: os.getRepo.use(provideServices).effect(
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
