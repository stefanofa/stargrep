import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AccountLookup from "./account.ts";
import {
  type GitHubError,
  GitHubRequestFailed,
  GitHubResponseInvalid,
  NotFound,
  type Operation,
  RateLimited,
  Unauthorized,
} from "./errors.ts";
import * as Readme from "./readme.ts";
import * as Facts from "./repo-facts.ts";
import {
  type Account,
  type GraphQLError,
  IntFromString,
  type Login,
  type ObjectId,
  type RepoFacts,
  type RepoName,
  type RepoNodeId,
  type Star,
} from "./schemas.ts";
import * as StarCount from "./star-count.ts";
import * as StarList from "./star-list.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";

const MAX_RETRY_WAIT = Duration.minutes(1);
const MAX_RETRIES = 3;

const graphQLErrorType = /^[A-Z_]{1,40}$/;

const decodeSeconds = Schema.decodeUnknownOption(IntFromString);

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<GitHubError>(),
  Schedule.modifyDelay(({ duration, input }) =>
    Effect.succeed(input._tag === "RateLimited" ? Duration.millis(input.retryAfterMillis) : duration),
  ),
);

const isRetryable = (error: GitHubError) => {
  if (error._tag === "RateLimited") return error.retryAfterMillis <= Duration.toMillis(MAX_RETRY_WAIT);
  if (error._tag !== "GitHubRequestFailed") return false;
  switch (error.reason) {
    case "transport":
    case "timeout":
      return true;
    case "status":
      return error.status !== null && error.status >= 500;
    case "graphql-errors":
      return false;
  }
};

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly account: (login: Login) => Effect.Effect<Account, GitHubError>;
    readonly starPages: (login: Login) => Stream.Stream<ReadonlyArray<Star>, GitHubError>;
    readonly stars: (login: Login) => Stream.Stream<Star, GitHubError>;
    readonly starCount: (login: Login) => Effect.Effect<number, GitHubError>;
    readonly repoFacts: (ids: ReadonlyArray<RepoNodeId>) => Effect.Effect<ReadonlyArray<RepoFacts>, GitHubError>;
    readonly readme: (input: {
      readonly owner: Login;
      readonly name: RepoName;
      readonly oid: ObjectId;
    }) => Effect.Effect<string, GitHubError>;
  }
>()("@stargrep/github/github") {}

interface Endpoint {
  readonly operation: Operation;
  readonly method: string;
  readonly path: string;
}

const rateLimitWait = (reply: TokenGate.Reply, now: number): Option.Option<number> =>
  Option.orElse(
    Option.map(decodeSeconds(reply.headers["retry-after"]), (seconds) => seconds * 1000),
    () =>
      reply.rateLimit.remaining.pipe(
        Option.filter((remaining) => remaining === 0),
        Option.flatMap(() => reply.rateLimit.resetAt),
        Option.map((resetAt) => Math.max(0, resetAt - now)),
      ),
  );

// GitHub sends a secondary rate limit as a 403 that can have quota left and no Retry-After, so only its message names it.
const secondaryLimit = /secondary rate limit|abuse detection/i;

const isRateLimit = (reply: TokenGate.Reply, now: number) =>
  reply.status === 429 ||
  (reply.status === 403 &&
    (Option.isSome(rateLimitWait(reply, now)) || Option.exists(reply.body, (body) => secondaryLimit.test(body))));

// GitHub asks for a one minute wait on a rate limit that names no reset time.
const rateLimited = (endpoint: Endpoint, reply: TokenGate.Reply, now: number) =>
  new RateLimited({
    operation: endpoint.operation,
    resource: Option.getOrElse(reply.rateLimit.resource, () => TokenBudget.resourceOf(endpoint.path)),
    retryAfterMillis: Option.getOrElse(rateLimitWait(reply, now), () => 60_000),
  });

const classify = (endpoint: Endpoint, reply: TokenGate.Reply, now: number): Result.Result<string, GitHubError> => {
  if (TokenGate.isSuccess(reply.status)) {
    return Option.match(reply.body, {
      onNone: () => Result.fail(new GitHubResponseInvalid({ ...endpoint, reason: "unreadable-body" })),
      onSome: Result.succeed,
    });
  }
  if (reply.status === 401) return Result.fail(new Unauthorized({ operation: endpoint.operation }));
  if (reply.status === 404) return Result.fail(new NotFound({ operation: endpoint.operation, path: endpoint.path }));
  if (isRateLimit(reply, now)) return Result.fail(rateLimited(endpoint, reply, now));
  return Result.fail(new GitHubRequestFailed({ ...endpoint, status: reply.status, reason: "status" }));
};

const graphQLFailure = (
  endpoint: Endpoint,
  reply: TokenGate.Reply,
  now: number,
  errors: ReadonlyArray<GraphQLError>,
): Effect.Effect<never, GitHubError> =>
  errors.some((error) => error.type === "RATE_LIMITED")
    ? Effect.fail(rateLimited(endpoint, reply, now))
    : Effect.logWarning("GitHub GraphQL errors", {
        count: errors.length,
        types: errors.flatMap((error) =>
          error.type !== undefined && graphQLErrorType.test(error.type) ? [error.type] : [],
        ),
      }).pipe(
        Effect.andThen(Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "graphql-errors" }))),
      );

const make = Effect.gen(function* () {
  const gate = yield* TokenGate.TokenGate;

  const exchange = <A>(
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
    interpret: (
      body: string,
      reply: TokenGate.Reply,
      endpoint: Endpoint,
      now: number,
    ) => Effect.Effect<A, GitHubError | Schema.SchemaError>,
  ) => {
    const endpoint = { operation, method: request.method, path: new URL(request.url).pathname };
    return gate
      .execute(
        operation,
        request.pipe(HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" })),
      )
      .pipe(
        Effect.flatMap((reply) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Result.match(classify(endpoint, reply, now), {
              onFailure: Effect.fail,
              onSuccess: (body) => interpret(body, reply, endpoint, now),
            }),
          ),
        ),
        Effect.catchTags({
          SchemaError: () => Effect.fail(new GitHubResponseInvalid({ ...endpoint, reason: "schema-mismatch" })),
        }),
        Effect.retry({ schedule: retrySchedule, while: isRetryable, times: MAX_RETRIES }),
      );
  };

  const account = Effect.fn("GitHub.account")(function* (login: Login) {
    return yield* exchange("account", AccountLookup.request(login), (body) =>
      Effect.map(AccountLookup.decodeUser(body), AccountLookup.toAccount),
    );
  });

  const starPage = Effect.fn("GitHub.starPage")(function* (login: Login, page: number) {
    return yield* exchange("list-stars", StarList.request(login, page), (body, reply, endpoint) =>
      Effect.gen(function* () {
        const items = yield* StarList.decodeStarItems(body);
        const next = StarList.nextPage(reply.headers.link);
        if (Result.isFailure(next)) return yield* new GitHubResponseInvalid({ ...endpoint, reason: "invalid-link" });
        return [items.map(StarList.toStar), next.success] as const;
      }),
    );
  });

  const starPages = (login: Login) =>
    Stream.paginate(1, (page: number) =>
      Effect.map(starPage(login, page), ([stars, next]) => [[stars], next] as const),
    );

  const stars = (login: Login) => Stream.flattenIterable(starPages(login));

  const factsBatch = Effect.fn("GitHub.factsBatch")(function* (ids: ReadonlyArray<RepoNodeId>) {
    return yield* exchange("repo-facts", Facts.request(ids), (raw, reply, endpoint, now) =>
      Effect.gen(function* () {
        const body = yield* Facts.decodeResponse(raw);
        const errors = (body.errors ?? []).filter((error) => error.type !== "NOT_FOUND");
        if (errors.length > 0 || !body.data) return yield* graphQLFailure(endpoint, reply, now, errors);
        return body.data.nodes.flatMap((node) => (node === null ? [] : [Facts.toFacts(node)]));
      }),
    );
  });

  const starCount = Effect.fn("GitHub.starCount")(function* (login: Login) {
    return yield* exchange("star-count", StarCount.request(login), (raw, reply, endpoint, now) =>
      Effect.gen(function* () {
        const body = yield* StarCount.decodeResponse(raw);
        const errors = body.errors ?? [];
        if (body.data?.user === null && errors.every((error) => error.type === "NOT_FOUND")) {
          return yield* new NotFound({ operation: "star-count", path: `/users/${login}` });
        }
        if (errors.length > 0 || !body.data?.user) return yield* graphQLFailure(endpoint, reply, now, errors);
        return body.data.user.starredRepositories.totalCount;
      }),
    );
  });

  const repoFacts = Effect.fn("GitHub.repoFacts")(function* (ids: ReadonlyArray<RepoNodeId>) {
    const batches = yield* Effect.forEach(Arr.chunksOf(ids, Facts.batchSize), factsBatch);
    return batches.flat();
  });

  const readme = Effect.fn("GitHub.readme")(function* (input: {
    readonly owner: Login;
    readonly name: RepoName;
    readonly oid: ObjectId;
  }) {
    return yield* exchange("readme", Readme.request(input), (body) => Effect.succeed(body));
  });

  return GitHub.of({ account, starPages, stars, starCount, repoFacts, readme });
});

export const layer = Layer.effect(GitHub, make);
