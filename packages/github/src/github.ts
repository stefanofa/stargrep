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
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type GitHubError,
  GitHubRequestFailed,
  GitHubResponseInvalid,
  NotFound,
  type Operation,
  RateLimited,
  Unauthorized,
} from "./errors.ts";
import * as GraphQL from "./graphql.ts";
import { apiHeaders } from "./headers.ts";
import * as Owner from "./owner.ts";
import * as RateLimit from "./rate-limit.ts";
import * as Readme from "./readme.ts";
import * as Facts from "./repo-facts.ts";
import type { GraphQLError, Login, ObjectId, RepoFacts, RepoName, RepoNodeId, Star } from "./schemas.ts";
import * as StarList from "./star-list.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";
import * as Viewer from "./viewer.ts";

const MAX_RETRY_WAIT = Duration.minutes(1);
const MAX_RETRIES = 3;

const graphQLErrorType = /^[A-Z_]{1,40}$/;

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
    case "malformed":
      return false;
  }
};

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly viewer: Effect.Effect<Viewer.SignedInViewer, GitHubError>;
    // None when GitHub has no user or org with the login.
    readonly owner: (login: Login) => Effect.Effect<Option.Option<Owner.Owner>, GitHubError>;
    readonly starPages: (login: Login) => Stream.Stream<ReadonlyArray<Star>, GitHubError>;
    readonly stars: (login: Login) => Stream.Stream<Star, GitHubError>;
    readonly repoFacts: (ids: ReadonlyArray<RepoNodeId>) => Effect.Effect<ReadonlyArray<RepoFacts>, GitHubError>;
    readonly readme: (input: {
      readonly owner: Login;
      readonly name: RepoName;
      readonly oid: ObjectId;
    }) => Effect.Effect<string, GitHubError>;
  }
>()("@stargrep/github/github") {}

type Endpoint = TokenGate.Endpoint;

const classify = (endpoint: Endpoint, reply: TokenGate.Reply, now: number): Result.Result<string, GitHubError> => {
  const meaning = RateLimit.classify(reply, now);
  switch (meaning._tag) {
    case "Ok":
      return Option.match(reply.body, {
        onNone: () => Result.fail(new GitHubResponseInvalid({ ...endpoint, reason: "unreadable-body" })),
        onSome: Result.succeed,
      });
    case "Unauthorized":
      return Result.fail(new Unauthorized({ operation: endpoint.operation }));
    case "NotFound":
      return Result.fail(new NotFound({ operation: endpoint.operation, path: endpoint.path }));
    case "RateLimited":
      return Result.fail(
        new RateLimited({
          operation: endpoint.operation,
          resource: Option.getOrElse(reply.rateLimit.resource, () => TokenBudget.resourceOf(endpoint.path)),
          retryAfterMillis: meaning.retryAfterMillis,
        }),
      );
    case "Failed":
      return Result.fail(new GitHubRequestFailed({ ...endpoint, status: reply.status, reason: "status" }));
  }
};

const graphQLFailure = (endpoint: Endpoint, errors: ReadonlyArray<GraphQLError>): Effect.Effect<never, GitHubError> =>
  Effect.logWarning("GitHub GraphQL errors", {
    count: errors.length,
    types: errors.flatMap((error) =>
      error.type !== undefined && graphQLErrorType.test(error.type) ? [error.type] : [],
    ),
  }).pipe(
    Effect.andThen(Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "graphql-errors" }))),
  );

const ownerQuery = GraphQL.operation(Owner.query, Owner.Data);
const viewerQuery = GraphQL.operation(Viewer.query, Viewer.Data);
const factsQuery = GraphQL.operation(Facts.query, Facts.Data);

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
    return gate.execute(operation, request.pipe(HttpClientRequest.setHeaders(apiHeaders))).pipe(
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

  const graphql = <A>(
    operation: Operation,
    query: ReturnType<typeof GraphQL.operation<A>>,
    variables: Readonly<Record<string, unknown>>,
    handled: (error: GraphQLError) => boolean = () => false,
  ) =>
    exchange(operation, query.request(variables), (raw, _reply, endpoint) =>
      Effect.gen(function* () {
        const body = yield* query.decode(raw);
        const errors = body.errors ?? [];
        const notFound = errors.every((error) => error.type === "NOT_FOUND");
        const unhandled = errors.filter((error) => !handled(error));
        if (unhandled.length > 0 || body.data === undefined || body.data === null) {
          return yield* graphQLFailure(endpoint, unhandled);
        }
        return { data: body.data, errors, notFound };
      }),
    );

  const owner = Effect.fn("GitHub.owner")(function* (login: Login) {
    const { data, notFound, errors } = yield* graphql(
      "owner",
      ownerQuery,
      { login },
      (error) => error.type === "NOT_FOUND",
    );
    if (data.repositoryOwner === null && notFound) return Option.none();
    if (errors.length > 0 || data.repositoryOwner === null) {
      return yield* graphQLFailure({ operation: "owner", method: "POST", path: "/graphql" }, errors);
    }
    return Option.some(Owner.toOwner(data.repositoryOwner));
  });

  const viewer = Effect.map(graphql("viewer", viewerQuery, {}), ({ data }) => Viewer.toViewer(data.viewer));

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
    const body = yield* graphql("repo-facts", factsQuery, { ids }, (error) => Facts.nodeError(error) !== null);
    const { facts, forbidden } = Facts.settle(ids, body);
    if (forbidden.length > 0) yield* Effect.logWarning("GitHub forbade repos to the token", { nodeIds: forbidden });
    return facts;
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

  return GitHub.of({ viewer, owner, starPages, stars, repoFacts, readme });
});

export const layer = Layer.effect(GitHub, make);
