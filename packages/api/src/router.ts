import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { implement } from "@orpc/server";
import * as Analytics from "@stargrep/analytics/analytics";
import { Feed } from "@stargrep/core/follows";
import { RateLine } from "@stargrep/core/limits";
import { MetricRegistry, QueryPlan, type QueryPlanner, Search } from "@stargrep/core/search";
import { OwnerAccount, SyncRequests, Taste } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import { loginKey } from "@stargrep/github/login";
import type { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { everything, normalize, SelectionKey } from "@stargrep/knowledge/atom";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { type AnswerContext, type AnswerPolicy, answerCache, miss, reader, searchWindows } from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import {
  type AppliedAtom,
  contract,
  type FacetMatches,
  type FollowedLogins,
  type Followed as FollowedOutput,
  type FollowedPeople,
  type FollowedStarrers,
  type FollowingFeed,
  type GitHubFollowing,
  type IconPlate,
  type Library,
  type MetricId,
  type MonthlyPicks,
  type maxFollows,
  type maxIconSize,
  maxStarsPage,
  type NewToYou,
  type OwnerType,
  type People,
  type PeopleInput,
  type PlanSource,
  type PublicConfig,
  PublicStars,
  type RepoDetail,
  RepoId,
  requiresSession,
  SearchInput,
  SearchOutput,
  type SimilarInput,
  SimilarPeople,
  type SimilarPeopleInput,
  SimilarRepos,
  type StarLanguages,
  StarsCursor,
  type StarsInput,
  type SyncInput,
  type SyncStatus,
  similarLimit,
  starredByLimit,
  Taste as TasteOutput,
  Topic,
  type TopicInput,
  type TopicPages,
  Topics,
  type TopicsInput,
  type Unfollowed,
  type Viewer as WireViewer,
} from "./contract.ts";
import { errorStatus, type WireCode, wireError } from "./errors.ts";
import { IconHost, iconUrl } from "./icon-host.ts";
import { instrumentation, type ProcedureTime, type Transport } from "./middleware/instrumentation.ts";
import { RateLimited, RateLimiter, type RateLimiterUnavailable, type RateLimitKind } from "./rate-limiter.ts";
import type { ApiServices, ApiServicesUnavailable } from "./services.ts";
import * as Services from "./services.ts";
import { topicIcon } from "./topic-icons.ts";
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
true satisfies Equals<typeof PeopleInput.Type.sort, Db.PeopleSort>;
true satisfies Equals<typeof maxFollows, typeof Feed.followCap>;

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
  TopicNotFound: "TOPIC_NOT_FOUND",
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

// A signed-in account's answers are its own, so no cache may store one, an error included. The URL is the same for every
// viewer, so a shared cache could otherwise hand one viewer's follows to another.
const privateAnswer = middlewareGen<Pick<AnswerContext, "resHeaders">>(function* ({ procedure, context, next }) {
  if (requiresSession(procedure)) context.resHeaders?.set("cache-control", "private, no-store");
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
  return yield* next();
});

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
      gone: entry.gone,
    })),
    labels,
  };
});

// Sorted and without repeats, so every request for the same atoms gets the answer the cache would give it.
const filterOf = (input: typeof SearchInput.Type) => normalize(input.filter ?? everything);

const searchAnswer = Effect.fnUntraced(function* (input: typeof SearchInput.Type) {
  const scope: Search.Scope =
    input.scope.kind === "stars"
      ? { _tag: "stars", login: input.scope.login }
      : { _tag: "topic", topic: input.scope.topic };
  const outcome = yield* (yield* Search.Search)
    .search({ scope, query: input.q, limit: input.limit, filter: filterOf(input) })
    .pipe(
      // The contract only accepts stars and topics, so this failure violates the service's contract.
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
    input.scope.kind === "stars" ? loginKey(input.scope.login) : input.scope.topic,
    input.scope.kind,
    input.limit,
    encodeSelection(filterOf(input)),
    QueryPlan.normalize(input.q).toLowerCase(),
  ].join("/");

// Only searches every visitor gets the same answer to are cached: the demo account's own stars, so the landing page
// answers without building any service, and a topic's repos, so a shared topic search costs one plan and one embedding.
const sharedSearchKey = (input: typeof SearchInput.Type, config: PublicConfig) =>
  input.scope.kind === "topic" || loginKey(input.scope.login) === loginKey(config.demoLogin)
    ? Option.some(answerKey(input))
    : Option.none();

const answerCacheOf = (headers: Headers | undefined): Analytics.AnswerCache => {
  const outcome = headers?.get("x-answer-cache");
  return outcome === "hit" || outcome === "stale" || outcome === "miss" ? outcome : "none";
};

type Searcher = Ref.Ref<Option.Option<Analytics.Actor>>;

// Sends one search event per search, a cache hit included, with no query text. The handler names the searcher once it
// has read the session. A cache hit reads none, so it names the request's own actor, the network.
const searchEvent = middlewareGen<
  Pick<ApiContext, "transport" | "resHeaders">,
  { readonly searcher: Searcher },
  typeof SearchInput.Type,
  typeof SearchOutput.Encoded
>(function* ({ context, next }) {
  const started = yield* Clock.currentTimeMillis;
  const searcher = yield* Ref.make(Option.none<Analytics.Actor>());
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
  const result = yield* next({ context: { searcher } });
  const event = Analytics.capture(
    Analytics.Event.Search({
      planSource: result.output.planSource,
      results: result.output.results.length,
      latencyMillis: (yield* Clock.currentTimeMillis) - started,
      answerCache: answerCacheOf(context.resHeaders),
      transport: context.transport,
    }),
  );
  yield* Option.match(yield* Ref.get(searcher), {
    onNone: () => event,
    onSome: (actor) => Analytics.withActor(actor)(event),
  });
  return result;
});

// A search reads the session only to name the searcher in analytics. A signed-out visitor sends no session cookie, and a
// signed-in visitor's cookie carries a five-minute cache of the session, so this seldom reads the database.
const searcherOf = Effect.gen(function* () {
  const { key } = yield* Caller;
  const signedIn = yield* (yield* Viewers).signedIn.pipe(Effect.orElseSucceed(Option.none));
  return Option.match(signedIn, {
    onNone: () => Analytics.Actor.Network({ caller: key }),
    onSome: (userId) => Analytics.Actor.User({ userId }),
  });
});

const decodeSearchInput = Schema.decodeEffect(SearchInput);
const readSearch = reader({ json: Schema.fromJsonString(SearchOutput), ...searchWindows });

// The answer search would serve from the cache, read without searching, so a server render can paint it with no model
// call, rate limit turn, or refresh. A search the cache never keeps, such as another login's, misses.
export const cachedSearch = (
  input: typeof SearchInput.Encoded,
  { answerCache, publicConfig }: Pick<ApiContext, "answerCache" | "publicConfig">,
) =>
  decodeSearchInput(input).pipe(
    Effect.flatMap((decoded) =>
      Option.match(sharedSearchKey(decoded, publicConfig), {
        onNone: () => Effect.succeed(miss),
        onSome: (key) => readSearch(answerCache, key),
      }),
    ),
    Effect.catchTags({ SchemaError: () => Effect.succeed(miss) }),
  );

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

// The binding admission takes from counts approximately and per location, so a page that misses the cache also takes
// a turn in its network's line in Postgres, which holds exactly. The turn comes before the account read, so asking for
// logins Stargrep never synced costs turns too.
const starsPage = Effect.fnUntraced(function* (login: Login, size: number, after: Option.Option<Db.StarsPosition>) {
  const db = yield* Db.Db;
  const { key } = yield* Caller;
  const turn = yield* RateLine.reserve(db.rateLines, RateLine.starsNetwork(key), yield* DateTime.now, 1);
  if (Option.isNone(turn)) return yield* new RateLimited({ limit: "network" });
  const account = yield* db.accounts.byLogin(login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login });
  const id = account.value.id;
  // A first page also says where every later page starts, so a client can read them all at once.
  const [page, cursors] = yield* Effect.all(
    [
      db.stars.page(id, { limit: size, after }),
      Option.isNone(after)
        ? Effect.map(db.stars.pageStarts(id, size), (starts) => ({
            cursors: starts.map((start) => encodeCursor(start)),
          }))
        : Effect.succeed({}),
    ],
    { concurrency: 2 },
  );
  return {
    login: account.value.login,
    ...(yield* libraryRepos(page.entries)),
    nextCursor: Option.getOrNull(Option.map(page.next, encodeCursor)),
    ...cursors,
  };
});

// Answers the first limit repos of a page, with the labels they use, and continues after the last one answered.
const firstOf = (page: typeof PublicStars.Encoded, limit: number): typeof PublicStars.Encoded => {
  const last = page.repos[limit - 1];
  if (page.repos.length <= limit || last === undefined) return page;
  const repos = page.repos.slice(0, limit);
  const kept = new Set(repos.flatMap((repo) => repo.atoms));
  // Later pages start at the page size's cursors, not this limit's.
  const { cursors: _cursors, ...rest } = page;
  return {
    ...rest,
    repos,
    labels: Object.fromEntries(Object.entries(page.labels).filter(([atom]) => kept.has(atom))),
    nextCursor: encodeCursor({ starredAt: DateTime.makeUnsafe(last.starredAt), repoId: RepoId.make(last.id) }),
  };
};

// Nearest repos change only when an embedding, a star, or a summary does, so an answer keeps for 10 minutes and is then
// served for up to a day while a refresh runs.
const similarAnswers: AnswerPolicy<typeof SimilarRepos.Encoded> = {
  procedure: "similarRepos",
  json: Schema.fromJsonString(Schema.toEncoded(SimilarRepos)),
  fresh: Duration.minutes(10),
  stale: Duration.days(1),
  keep: () => true,
  refused: refusesRequest,
};

const similarRepos = Effect.fnUntraced(function* (input: typeof SimilarInput.Type) {
  const db = yield* Db.Db;
  const account = yield* db.accounts.byLogin(input.login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login: input.login });
  yield* db.repos.require(input.id);
  const query = { accountId: account.value.id, repoId: input.id, limit: similarLimit };
  const [{ inStars, notStarred }, starredBy] = yield* Effect.all(
    [
      db.similar.near(query),
      db.people.starredBy({ repoId: input.id, except: account.value.id, limit: starredByLimit }),
    ],
    { concurrency: 2 },
  );
  const icons = yield* IconHost;
  const wire = (found: Db.SimilarRepo) => ({ ...repoBase(found.repo, icons), stars: found.stars });
  return { starredBy, inStars: inStars.map(wire), notStarred: notStarred.map(wire) };
});

const personFields = (person: Db.Person) => ({
  login: person.login,
  avatarUrl: person.avatarUrl,
  curated: person.curated,
  stars: person.stars,
  lastStarredAt: DateTime.formatIso(person.lastStarredAt),
  languages: person.languages,
  topics: person.topics,
});

// The account the list counts shared stars for: the signed-in one, once its stars have synced. A session that cannot be
// read lists people as for anyone signed out.
const peopleViewer = Effect.gen(function* () {
  const signedIn = yield* (yield* Viewers).signedIn.pipe(Effect.orElseSucceed(Option.none));
  if (Option.isNone(signedIn)) return Option.none();
  const account = yield* (yield* Db.Db).accounts.claimedBy(signedIn.value);
  return Option.flatMap(account, (found) => (found.starsSyncedAt === null ? Option.none() : Option.some(found.id)));
});

const people = Effect.fnUntraced(function* (input: typeof PeopleInput.Type, context: AnswerContext) {
  const viewer = yield* peopleViewer;
  const sort = Option.isSome(viewer) ? input.sort : "recently-active";
  const page = yield* (yield* Db.Db).people.page({
    sort,
    viewer,
    topic: Option.fromUndefinedOr(input.topic),
    offset: input.offset,
    limit: input.limit,
  });
  const next = input.offset + page.people.length;
  // The list changes once a night, so an answer without shared counts keeps for 5 minutes in any cache. One with them
  // is the viewer's alone.
  context.resHeaders?.set("cache-control", Option.isSome(viewer) ? "private, max-age=60" : "public, max-age=300");
  context.resHeaders?.set("vary", "cookie");
  return {
    sort,
    people: page.people.map((person) => ({ ...personFields(person), shared: person.shared })),
    total: page.total,
    nextOffset: page.people.length > 0 && next < page.total ? next : null,
    topics: page.topics,
  };
});

// The list and its copy of stars change once a night, so an answer keeps for 10 minutes and is then served for up to a
// day while a refresh runs.
const similarPeopleAnswers: AnswerPolicy<typeof SimilarPeople.Encoded> = {
  procedure: "similarPeople",
  json: Schema.fromJsonString(Schema.toEncoded(SimilarPeople)),
  fresh: Duration.minutes(10),
  stale: Duration.days(1),
  keep: () => true,
  refused: refusesRequest,
};

const similarPeople = Effect.fnUntraced(function* (input: typeof SimilarPeopleInput.Type) {
  const db = yield* Db.Db;
  const account = yield* db.accounts.byLogin(input.login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login: input.login });
  const found = yield* db.people.like(account.value.id, input.limit, Option.fromUndefinedOr(input.topic));
  return { people: found.map((person) => ({ ...personFields(person), shared: person.shared })) };
});

// A login's taste changes only when its stars sync, so an answer keeps for 10 minutes and is then served for up to a
// day while a refresh runs. A login whose stars are still arriving has none to keep.
const tasteAnswers: AnswerPolicy<typeof TasteOutput.Encoded> = {
  procedure: "taste",
  json: Schema.fromJsonString(Schema.toEncoded(TasteOutput)),
  fresh: Duration.minutes(10),
  stale: Duration.days(1),
  keep: (answer) => answer.stars > 0,
  refused: refusesRequest,
};

const taste = Effect.fnUntraced(function* (input: typeof SyncInput.Type) {
  const account = yield* (yield* Db.Db).accounts.byLogin(input.login);
  if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login: input.login });
  const found = yield* Taste.read(account.value.id);
  return {
    ...found,
    login: account.value.login,
    stars: found.languages.total,
    starredOnGitHub: account.value.starredCount,
    languages: found.languages.languages,
  };
});

// Topic pages change once a night, so an answer keeps for 10 minutes and is then served for up to a day while a refresh
// runs.
const topicWindows = { fresh: Duration.minutes(10), stale: Duration.days(1) };

const topicsAnswers: AnswerPolicy<typeof Topics.Encoded> = {
  procedure: "topics",
  json: Schema.fromJsonString(Schema.toEncoded(Topics)),
  ...topicWindows,
  keep: () => true,
  refused: refusesRequest,
};

const topicAnswers: AnswerPolicy<typeof Topic.Encoded> = {
  procedure: "topic",
  json: Schema.fromJsonString(Schema.toEncoded(Topic)),
  ...topicWindows,
  keep: () => true,
  refused: refusesRequest,
};

const topicCount = ({ home, ...count }: Db.TopicCount, icons: IconHost["Service"]) => ({
  ...count,
  icon: topicIcon(icons, count.topic, home),
});

const listTopics = Effect.fnUntraced(function* (input: typeof TopicsInput.Type) {
  const page = yield* (yield* Db.Db).topics.list({ q: input.q ?? "", offset: input.offset, limit: input.limit });
  const icons = yield* IconHost;
  const next = input.offset + page.topics.length;
  return {
    topics: page.topics.map((count) => topicCount(count, icons)),
    total: page.total,
    nextOffset: page.topics.length > 0 && next < page.total ? next : null,
  };
});

// A spelling of a topic answers with the page of the topic it means, under that topic's own name.
const topicPage = Effect.fnUntraced(function* (input: typeof TopicInput.Type) {
  const db = yield* Db.Db;
  const notFound = new Search.TopicNotFound({ topic: input.topic });
  const topic = yield* db.topics.resolve(input.topic);
  if (Option.isNone(topic)) return yield* notFound;
  const page = yield* db.topics.page(topic.value);
  if (Option.isNone(page)) return yield* notFound;
  const icons = yield* IconHost;
  const wire = (listed: Db.TopicRepo) => ({ ...repoBase(listed.repo, icons), devs: listed.devs, stars: listed.stars });
  const { home, core, built, related, ...rest } = page.value;
  const own = Option.getOrNull(home);
  return {
    ...rest,
    icon: topicIcon(icons, rest.topic, own && { owner: own.repo.owner, icon: own.repo.icon }),
    home: own && wire(own),
    core: core.map(wire),
    built: built.map(wire),
    related: related.map((count) => topicCount(count, icons)),
  };
});

// Follows are the signed-in account's own, so every read below names it as the follower and no input names another.
// Each follow or unfollow takes a turn in the account's line.
const followTurn = Effect.fnUntraced(function* (account: Db.Account) {
  const turn = yield* RateLine.reserve(
    (yield* Db.Db).rateLines,
    RateLine.followsAccount(account.id),
    yield* DateTime.now,
    1,
  );
  if (Option.isNone(turn)) return yield* new RateLimited({ limit: "account" });
});

const followedPerson = (person: Db.Followee) => ({
  login: person.login,
  avatarUrl: person.avatarUrl,
  source: person.source,
  followedAt: DateTime.formatIso(person.followedAt),
  lastStarredAt: iso(person.lastStarredAt),
  checkedAt: iso(person.checkedAt),
});

const oldest = (times: ReadonlyArray<DateTime.Utc>) =>
  times.reduce<DateTime.Utc | null>((min, time) => (min === null || DateTime.isLessThan(time, min) ? time : min), null);

const newestStar = (people: ReadonlyArray<Db.Followee>) =>
  people.reduce<{ readonly login: string; readonly starredAt: DateTime.Utc } | null>((best, person) => {
    if (person.lastStarredAt === null) return best;
    return best !== null && !DateTime.isGreaterThan(person.lastStarredAt, best.starredAt)
      ? best
      : { login: person.login, starredAt: person.lastStarredAt };
  }, null);

// The followees' stars in the window, one row per repo the account doesn't star, with the week's top repo and busiest
// people. Repos GitHub no longer serves drop out with their rows.
const followingFeed = Effect.fnUntraced(function* (account: Db.Account) {
  const db = yield* Db.Db;
  const now = yield* DateTime.now;
  const [people, stars] = yield* Effect.all(
    [
      db.follows.list(account.id),
      db.follows.stars({
        follower: account.id,
        since: DateTime.subtractDuration(now, Feed.window),
        perFollowee: Feed.perFollowee,
      }),
    ],
    { concurrency: 2 },
  );
  const feed = Feed.assemble(stars, now);
  const cards = new Map(
    (yield* db.follows.repos(feed.rows.map((row) => row.repoId))).map((card) => [card.repo.id, card] as const),
  );
  // The two reads run side by side, so a star can name someone unfollowed in between. It is left out.
  const byId = new Map(people.map((person) => [person.id, person] as const));
  const named = new Set<string>();
  const loginOf = (id: GitHubAccountId) => {
    const login = byId.get(id)?.login;
    if (login !== undefined) named.add(login);
    return login === undefined ? [] : [login];
  };
  const icons = yield* IconHost;
  const repos = feed.rows.flatMap((row) => {
    const card = cards.get(row.repoId);
    if (card === undefined) return [];
    return [
      {
        ...repoBase(card.repo, icons),
        stars: card.stars,
        starredBy: row.starredBy.flatMap((starrer) =>
          loginOf(starrer.followee).map((login) => ({ login, starredAt: DateTime.formatIso(starrer.starredAt) })),
        ),
      },
    ];
  });
  const top = Option.getOrNull(Option.filter(feed.top, (found) => cards.has(found.repoId)));
  const busiest = feed.busiest.flatMap((busy) =>
    loginOf(busy.followee).map((login) => ({ login, stars: busy.stars, latestAt: DateTime.formatIso(busy.latestAt) })),
  );
  const last = newestStar(people);
  if (last !== null) named.add(last.login);
  return {
    following: people.length,
    arriving: people.filter((person) => person.starsSyncedAt === null).length,
    checkedAt: iso(oldest(people.flatMap((person) => (person.checkedAt === null ? [] : [person.checkedAt])))),
    windowDays: Duration.toDays(Feed.window),
    avatars: Object.fromEntries(
      people.filter((person) => named.has(person.login)).map((person) => [person.login, person.avatarUrl] as const),
    ),
    repos,
    top: top && { id: top.repoId, starrers: top.starrers },
    busiest,
    lastStar: last && { login: last.login, starredAt: DateTime.formatIso(last.starredAt) },
  };
});

// The account's GitHub following, read with its own token once a day, kept to the users whose stars Stargrep holds. A
// read GitHub fails gives the day's turn back.
const githubFollowing = Effect.fnUntraced(function* (account: Db.Account) {
  const db = yield* Db.Db;
  const viewers = yield* Viewers;
  const turn = yield* RateLine.reserve(db.rateLines, RateLine.followingImport(account.id), yield* DateTime.now, 1);
  if (Option.isNone(turn)) return yield* new RateLimited({ limit: "account" });
  const followed = yield* viewers.githubFollowing.pipe(
    Effect.tapError(() => Effect.flatMap(DateTime.now, (now) => db.rateLines.release(turn.value, now))),
  );
  const [known, mine] = yield* Effect.all([
    db.follows.known(followed.map((user) => user.id)),
    db.follows.followed(account.id),
  ]);
  const following = new Set(mine.map((followed) => loginKey(followed.login)));
  return {
    people: known.map((person) => ({
      login: person.login,
      avatarUrl: person.avatarUrl,
      following: following.has(loginKey(person.login)),
    })),
    notOnStargrep: followed.length - known.length,
  };
});

const syncStatus =
  (login: Login) =>
  ([status, enrichment]: readonly [SyncRequests.SyncStatus, Db.EnrichmentProgress]): typeof SyncStatus.Type => {
    const common = { login, starredTotal: status.starredTotal, accountType: status.accountType, enrichment };
    switch (status.state) {
      case "unknown":
      case "missing":
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
const withServices = os.use(privateAnswer).use(Services.services).use(session);

const searchCache = answerCache(searchAnswers, (input: typeof SearchInput.Type, context: ApiContext) =>
  sharedSearchKey(input, context.publicConfig),
);
const starsCache = answerCache(starsAnswers, (input: typeof StarsInput.Type, _context: ApiContext) =>
  Option.some(
    `stars/${loginKey(input.login)}/${pageSizeFor(input.limit)}/${input.cursor === undefined ? "" : encodeCursor(input.cursor)}`,
  ),
);

const similarCache = answerCache(similarAnswers, (input: typeof SimilarInput.Type, _context: ApiContext) =>
  Option.some(`similar/${loginKey(input.login)}/${input.id}`),
);

const similarPeopleCache = answerCache(
  similarPeopleAnswers,
  (input: typeof SimilarPeopleInput.Type, _context: ApiContext) =>
    Option.some(`similar-people/${loginKey(input.login)}/${input.limit}/${input.topic ?? ""}`),
);

const tasteCache = answerCache(tasteAnswers, (input: typeof SyncInput.Type, _context: ApiContext) =>
  Option.some(`taste/${loginKey(input.login)}`),
);

const topicsCache = answerCache(topicsAnswers, (input: typeof TopicsInput.Type, _context: ApiContext) =>
  Option.some(`topics/${input.limit}/${input.offset}/${(input.q ?? "").trim().toLowerCase()}`),
);

const topicCache = answerCache(topicAnswers, (input: typeof TopicInput.Type, _context: ApiContext) =>
  Option.some(`topic/${input.topic}`),
);

const similarResponse = middlewareGen<AnswerContext>(function* ({ context, next }) {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
  const result = yield* next();
  context.resHeaders?.set("cache-control", "public, max-age=300");
  return result;
});

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
    .use(searchEvent)
    .use(searchCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input, context }): ApiResult<"search", typeof SearchOutput.Type> {
      const searcher = yield* searcherOf;
      yield* Ref.set(context.searcher, Option.some(searcher));
      return yield* searchAnswer(input).pipe(Analytics.withActor(searcher));
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

  monthlyPicks: withServices.monthlyPicks.effect(function* ({
    context,
  }): ApiResult<"monthlyPicks", typeof MonthlyPicks.Type> {
    const { userId } = yield* context.viewer;
    return { optedIn: yield* (yield* Db.Db).monthlyPicks.optedIn(userId) };
  }),

  setMonthlyPicks: withServices.setMonthlyPicks.effect(function* ({
    input,
    context,
  }): ApiResult<"setMonthlyPicks", typeof MonthlyPicks.Type> {
    const { userId } = yield* context.viewer;
    const changed = yield* (yield* Db.Db).monthlyPicks.set(userId, input.optedIn);
    if (changed) {
      const event = input.optedIn ? Analytics.Event.MonthlyPicksOptedIn() : Analytics.Event.MonthlyPicksOptedOut();
      yield* Analytics.capture(event).pipe(Analytics.withActor(Analytics.Actor.User({ userId })));
    }
    return { optedIn: input.optedIn };
  }),

  follow: withServices.follow.effect(function* ({ input, context }): ApiResult<"follow", typeof FollowedOutput.Type> {
    const { userId, account } = yield* context.viewer;
    yield* followTurn(account);
    const result = yield* (yield* Db.Db).follows.follow({
      follower: account.id,
      logins: input.logins,
      source: input.source,
      cap: Feed.followCap,
    });
    if (result.added > 0)
      yield* Analytics.capture(
        Analytics.Event.Followed({ added: result.added, source: input.source, following: result.total }),
      ).pipe(Analytics.withActor(Analytics.Actor.User({ userId })));
    return { following: result.following, total: result.total, full: result.full };
  }),

  unfollow: withServices.unfollow.effect(function* ({ input, context }): ApiResult<"unfollow", typeof Unfollowed.Type> {
    const { userId, account } = yield* context.viewer;
    yield* followTurn(account);
    const unfollowed = yield* (yield* Db.Db).follows.unfollow(account.id, input.login);
    if (unfollowed)
      yield* Analytics.capture(Analytics.Event.Unfollowed()).pipe(
        Analytics.withActor(Analytics.Actor.User({ userId })),
      );
    return { unfollowed };
  }),

  followedLogins: withServices.followedLogins.use(admission("search")).effect(function* ({
    context,
  }): ApiResult<"followedLogins", typeof FollowedLogins.Type> {
    const { account } = yield* context.viewer;
    const followed = yield* (yield* Db.Db).follows.followed(account.id);
    return {
      follows: followed.map(({ login, followedAt }) => ({ login, followedAt: DateTime.formatIso(followedAt) })),
    };
  }),

  followedPeople: withServices.followedPeople.use(admission("search")).effect(function* ({
    context,
  }): ApiResult<"followedPeople", typeof FollowedPeople.Type> {
    const { account } = yield* context.viewer;
    return { people: (yield* (yield* Db.Db).follows.list(account.id)).map(followedPerson) };
  }),

  followingFeed: withServices.followingFeed.use(admission("search")).effect(function* ({
    context,
  }): ApiResult<"followingFeed", typeof FollowingFeed.Type> {
    const { account } = yield* context.viewer;
    return yield* followingFeed(account);
  }),

  githubFollowing: withServices.githubFollowing.effect(function* ({
    context,
  }): ApiResult<"githubFollowing", typeof GitHubFollowing.Type> {
    const { account } = yield* context.viewer;
    return yield* githubFollowing(account);
  }),

  followedStarrers: withServices.followedStarrers.use(admission("search")).effect(function* ({
    input,
    context,
  }): ApiResult<"followedStarrers", typeof FollowedStarrers.Type> {
    const { account } = yield* context.viewer;
    const db = yield* Db.Db;
    const owner = yield* db.accounts.byLogin(input.login);
    if (Option.isNone(owner)) return { people: [], total: 0 };
    return yield* db.follows.starredBy({
      follower: account.id,
      repoId: input.id,
      except: owner.value.id,
      limit: starredByLimit,
    });
  }),

  // The viewer's stars are compared only once they have synced, so a first import still running counts nothing.
  newToYou: withServices.newToYou.use(admission("search")).effect(function* ({
    input,
    context,
  }): ApiResult<"newToYou", typeof NewToYou.Type> {
    const { account } = yield* context.viewer;
    const db = yield* Db.Db;
    const owner = yield* db.accounts.byLogin(input.login);
    if (Option.isNone(owner)) return yield* new Search.AccountNotSynced({ login: input.login });
    if (account.starsSyncedAt === null) return { shared: null, repos: [], labels: {} };
    const found = yield* db.stars.newToYou({ viewer: account.id, owner: owner.value.id, limit: input.limit });
    return { shared: found.shared, ...(yield* libraryRepos(found.entries)) };
  }),

  stars: os.stars
    .use(starsResponse)
    .use(starsCache)
    .use(Services.services)
    .use(admission("stars"))
    .effect(function* ({ input }): ApiResult<"stars", typeof PublicStars.Type> {
      return yield* starsPage(input.login, pageSizeFor(input.limit), Option.fromUndefinedOr(input.cursor));
    }),

  // One grouped database read with no model call, so it takes from the search binding as lookupFacets does.
  starLanguages: withServices.starLanguages.use(admission("search")).effect(function* ({
    input,
  }): ApiResult<"starLanguages", typeof StarLanguages.Type> {
    const db = yield* Db.Db;
    const account = yield* db.accounts.byLogin(input.login);
    if (Option.isNone(account)) return yield* new Search.AccountNotSynced({ login: input.login });
    return { login: account.value.login, ...(yield* db.stars.languages(account.value.id)) };
  }),

  // Database reads with no model call, so they take from the search binding, and only on a miss.
  taste: os.taste
    .use(similarResponse)
    .use(tasteCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"taste", typeof TasteOutput.Type> {
      return yield* taste(input);
    }),

  // A database read with no model call, so it takes from the search binding as lookupFacets does, and only on a miss.
  similarRepos: os.similarRepos
    .use(similarResponse)
    .use(similarCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"similarRepos", typeof SimilarRepos.Type> {
      return yield* similarRepos(input);
    }),

  // A database read with no model call, so it takes from the search binding. Its answer depends on the session, so the
  // answer cache keeps none and HTTP caching does the rest.
  people: withServices.people.use(admission("search")).effect(function* ({
    input,
    context,
  }): ApiResult<"people", typeof People.Type> {
    return yield* people(input, context);
  }),

  similarPeople: os.similarPeople
    .use(similarResponse)
    .use(similarPeopleCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"similarPeople", typeof SimilarPeople.Type> {
      return yield* similarPeople(input);
    }),

  lookupFacets: withServices.lookupFacets.use(admission("search")).effect(function* ({
    input,
  }): ApiResult<"lookupFacets", typeof FacetMatches.Type> {
    return { facets: yield* (yield* Db.Db).facets.lookup({ q: input.q, limit: input.limit }) };
  }),

  // Database reads with no model call, so they take from the search binding, and only on a miss.
  listTopics: os.listTopics
    .use(similarResponse)
    .use(topicsCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"listTopics", typeof Topics.Type> {
      return yield* listTopics(input);
    }),

  topic: os.topic
    .use(similarResponse)
    .use(topicCache)
    .use(Services.services)
    .use(admission("search"))
    .effect(function* ({ input }): ApiResult<"topic", typeof Topic.Type> {
      return yield* topicPage(input);
    }),

  topicPages: withServices.topicPages.use(admission("search")).effect(function* ({
    input,
  }): ApiResult<"topicPages", typeof TopicPages.Type> {
    return { pages: yield* (yield* Db.Db).topics.pages(input.topics) };
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
