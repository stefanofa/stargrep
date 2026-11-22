import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
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
import * as StarProbe from "./star-probe.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";
import * as Viewer from "./viewer.ts";

export type { ArchiveRef, Unresolved } from "./repo-facts.ts";

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
  if (error._tag === "RateLimited")
    return error.deferredUntil === undefined && error.retryAfterMillis <= Duration.toMillis(MAX_RETRY_WAIT);
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
    // Newest first, and never past the last page GitHub serves, so a list longer than that ends early.
    readonly starPages: (login: Login) => Stream.Stream<ReadonlyArray<Star>, GitHubError>;
    readonly stars: (login: Login) => Stream.Stream<Star, GitHubError>;
    // Each account's starred total and newest star, up to StarProbe.maxBatch accounts to a GraphQL request. An account
    // whose login GitHub no longer has, or that now names another account, comes back as missing, and the rest of its
    // batch is kept.
    readonly probeStars: (targets: ReadonlyArray<StarProbe.Target>) => Effect.Effect<StarProbe.Answer, GitHubError>;
    // Facts for the repos GitHub still serves. A repo GitHub sent in a shape the decoder refuses, or left unanswered even
    // when read alone, is logged and returned as invalid, and the rest of its batch is kept.
    readonly repoFacts: (ids: ReadonlyArray<RepoNodeId>) => Effect.Effect<
      {
        readonly facts: ReadonlyArray<RepoFacts>;
        readonly invalid: ReadonlyArray<RepoNodeId>;
      },
      GitHubError
    >;
    // Facts for repos an archive names by ID and full name, looked up by name in batches, kept only where GitHub's ID
    // matches the archive's. The rest are returned as unresolved.
    readonly resolveRepos: (refs: ReadonlyArray<Facts.ArchiveRef>) => Effect.Effect<
      {
        readonly facts: ReadonlyArray<RepoFacts>;
        readonly unresolved: ReadonlyArray<Facts.Unresolved>;
      },
      GitHubError
    >;
    readonly readme: (input: {
      readonly owner: Login;
      readonly name: RepoName;
      readonly oid: ObjectId;
    }) => Effect.Effect<string, GitHubError>;
    // README texts by object ID, read through GraphQL in batches. One GitHub cannot return byte for byte is left out for
    // readme to read, such as one whose repo is gone or whose text GraphQL cut short, and so is every README of a batch
    // GitHub failed to answer. A rate limit or a token problem would stop those reads too, so it fails the call.
    readonly readmes: (
      refs: ReadonlyArray<Readme.ReadmeRef>,
    ) => Effect.Effect<ReadonlyMap<ObjectId, string>, GitHubError>;
  }
>()("@stargrep/github/github") {}

type Endpoint = TokenGate.Endpoint;

const classify = (endpoint: Endpoint, reply: TokenGate.Reply, now: number): Result.Result<string, GitHubError> => {
  const meaning = RateLimit.classify(reply, now, endpoint.path);
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

const logInvalid = (invalid: ReadonlyArray<Facts.Invalid<RepoNodeId | number>>) =>
  Effect.forEach(
    invalid,
    ({ key, issue }) => Effect.logWarning("GitHub sent repo facts the decoder refuses", { repo: key, issue }),
    { discard: true },
  );

const gaveUp = (repo: RepoNodeId | number, error: GitHubError) =>
  Effect.logWarning("GitHub left a repo's facts unanswered even alone", { repo, error: error.message });

// GitHub cuts a query off at 10 s and then answers 502, 504, or a 200 whose body is not JSON. A facts batch holding a
// repo with a huge root tree can pass that limit.
const cutOff = (error: GitHubError) =>
  error._tag === "GitHubResponseInvalid" ||
  (error._tag === "GitHubRequestFailed" && (error.status === 502 || error.status === 504));

// Reads a batch GitHub cut off again as two halves. When both halves are cut off too, GitHub is failing every read and
// the error stands. Otherwise the half that failed is split again, down to the one key that fails alone, which lone
// answers for, so the rest of the batch goes on.
const halving = <K, A>(
  read: (keys: ReadonlyArray<K>) => Effect.Effect<A, GitHubError>,
  lone: (key: K, error: GitHubError) => Effect.Effect<A>,
  combine: (parts: ReadonlyArray<A>) => A,
) => {
  const split = (keys: ReadonlyArray<K>, error: GitHubError): Effect.Effect<A, GitHubError> => {
    const [only, ...rest] = keys;
    if (only !== undefined && rest.length === 0) return lone(only, error);
    const halves = Arr.splitAt(keys, Math.ceil(keys.length / 2));
    return Effect.forEach(halves, (half) => Effect.result(read(half))).pipe(
      Effect.flatMap((results) =>
        results.every((result) => Result.isFailure(result) && cutOff(result.failure))
          ? Effect.fail(error)
          : Effect.forEach(Arr.zip(halves, results), ([half, result]) =>
              Result.isSuccess(result)
                ? Effect.succeed(result.success)
                : cutOff(result.failure)
                  ? split(half, result.failure)
                  : Effect.fail(result.failure),
            ),
      ),
      Effect.map(combine),
    );
  };
  return (keys: ReadonlyArray<K>) =>
    read(keys).pipe(
      Effect.catchIf(
        (error) => keys.length > 1 && cutOff(error),
        (error) => split(keys, error),
      ),
    );
};

const ownerQuery = GraphQL.operation(Owner.query, Owner.Data);
const viewerQuery = GraphQL.operation(Viewer.query, Viewer.Data);
const factsQuery = GraphQL.operation(Facts.query, Facts.Data);

const make = Effect.gen(function* () {
  const gate = yield* TokenGate.TokenGate;
  const digest = yield* Digest.Digest;

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
        ).pipe(
          Effect.tapError((failure) =>
            failure._tag === "RateLimited" ? Effect.sync(() => reply.onRateLimited?.(failure)) : Effect.void,
          ),
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
        const json = GraphQL.parse(raw);
        if (Option.isNone(json)) return yield* new GitHubResponseInvalid({ ...endpoint, reason: "unreadable-body" });
        const body = yield* query.decode(json.value);
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
      Effect.map(
        starPage(login, page),
        ([stars, next]) => [[stars], Option.filter(next, (number) => number <= StarList.lastPage)] as const,
      ),
    );

  const stars = (login: Login) => Stream.flattenIterable(starPages(login));

  const probeBatch = Effect.fn("GitHub.probeBatch")(function* (targets: ReadonlyArray<StarProbe.Target>) {
    const query = GraphQL.operation(StarProbe.query(targets.length), StarProbe.Data);
    const { data } = yield* graphql("probe-stars", query, StarProbe.variables(targets), StarProbe.isAliasError);
    return StarProbe.settle(targets, data);
  });

  const combineProbes = (parts: ReadonlyArray<StarProbe.Answer>): StarProbe.Answer => ({
    probed: parts.flatMap((part) => part.probed),
    missing: parts.flatMap((part) => part.missing),
    cost: parts.reduce((total, part) => total + part.cost, 0),
  });

  const readProbe = halving(
    probeBatch,
    (target: StarProbe.Target, error) =>
      Effect.logWarning("GitHub left an account's star probe unanswered even alone", {
        account: target.id,
        error: error.message,
      }).pipe(Effect.as({ probed: [], missing: [target.id], cost: 0 })),
    combineProbes,
  );

  const probeStars = Effect.fn("GitHub.probeStars")(function* (targets: ReadonlyArray<StarProbe.Target>) {
    return combineProbes(yield* Effect.forEach(Arr.chunksOf(targets, StarProbe.maxBatch), readProbe));
  });

  const factsBatch = Effect.fn("GitHub.factsBatch")(function* (ids: ReadonlyArray<RepoNodeId>) {
    const body = yield* graphql("repo-facts", factsQuery, { ids }, (error) => Facts.nodeError(error) !== null);
    const { facts, forbidden, invalid } = Facts.settle(ids, body);
    if (forbidden.length > 0) yield* Effect.logWarning("GitHub forbade repos to the token", { nodeIds: forbidden });
    yield* logInvalid(invalid);
    return { facts, invalid: invalid.map((entry) => entry.key) };
  });

  const combineFacts = (
    parts: ReadonlyArray<{ readonly facts: ReadonlyArray<RepoFacts>; readonly invalid: ReadonlyArray<RepoNodeId> }>,
  ) => ({
    facts: parts.flatMap((part) => part.facts),
    invalid: parts.flatMap((part) => part.invalid),
  });

  const readFacts = halving(
    factsBatch,
    (nodeId: RepoNodeId, error) => gaveUp(nodeId, error).pipe(Effect.as({ facts: [], invalid: [nodeId] })),
    combineFacts,
  );

  const repoFacts = Effect.fn("GitHub.repoFacts")(function* (ids: ReadonlyArray<RepoNodeId>) {
    return combineFacts(yield* Effect.forEach(Arr.chunksOf(ids, Facts.batchSize), readFacts));
  });

  const resolveBatch = Effect.fn("GitHub.resolveBatch")(function* (refs: ReadonlyArray<Facts.ArchiveRef>) {
    const query = GraphQL.operation(Facts.resolveQuery(refs.length), Facts.ResolveData);
    const body = yield* graphql("repo-facts", query, Facts.resolveVariables(refs), Facts.isAliasError);
    const { facts, unresolved, invalid } = Facts.settleResolved(refs, body);
    yield* logInvalid(invalid);
    return { facts, unresolved };
  });

  const combineResolved = (
    parts: ReadonlyArray<{
      readonly facts: ReadonlyArray<RepoFacts>;
      readonly unresolved: ReadonlyArray<Facts.Unresolved>;
    }>,
  ) => ({
    facts: parts.flatMap((part) => part.facts),
    unresolved: parts.flatMap((part) => part.unresolved),
  });

  const readResolved = halving(
    resolveBatch,
    (ref: Facts.ArchiveRef, error) =>
      gaveUp(ref.id, error).pipe(Effect.as({ facts: [], unresolved: [{ id: ref.id, reason: "invalid" as const }] })),
    combineResolved,
  );

  const resolveRepos = Effect.fn("GitHub.resolveRepos")(function* (refs: ReadonlyArray<Facts.ArchiveRef>) {
    return combineResolved(yield* Effect.forEach(Arr.chunksOf(refs, Facts.batchSize), readResolved));
  });

  const readme = Effect.fn("GitHub.readme")(function* (input: {
    readonly owner: Login;
    readonly name: RepoName;
    readonly oid: ObjectId;
  }) {
    return yield* exchange("readme", Readme.request(input), (body) => Effect.succeed(body));
  });

  const unanswered = (error: GitHubRequestFailed | GitHubResponseInvalid) =>
    Effect.logWarning("GitHub left a README batch unanswered, reading its READMEs over REST", {
      error: error._tag,
      reason: error.reason,
    }).pipe(Effect.as(new Map<ObjectId, string>()));

  const readmeBatch = Effect.fn("GitHub.readmeBatch")(
    function* (refs: ReadonlyArray<Readme.ReadmeRef>) {
      const query = GraphQL.operation(Readme.batchQuery(refs.length), Readme.BatchData);
      const { data } = yield* graphql("readme", query, Readme.batchVariables(refs), Readme.isAliasError);
      return yield* Effect.provideService(Readme.verify(refs, data), Digest.Digest, digest);
    },
    Effect.catchTags({ GitHubRequestFailed: unanswered, GitHubResponseInvalid: unanswered }),
  );

  const readmes = Effect.fn("GitHub.readmes")(function* (refs: ReadonlyArray<Readme.ReadmeRef>) {
    const unique = Arr.dedupeWith(refs, (a, b) => a.oid === b.oid);
    const batches = yield* Effect.forEach(Arr.chunksOf(unique, Readme.batchSize), readmeBatch);
    return new Map(batches.flatMap((batch) => [...batch]));
  });

  return GitHub.of({ viewer, owner, starPages, stars, probeStars, repoFacts, resolveRepos, readme, readmes });
});

export const layer = Layer.effect(GitHub, make).pipe(Layer.provide(Digest.layerWebCrypto));
