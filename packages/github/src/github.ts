import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
import * as Readme from "./readme.ts";
import * as Facts from "./repo-facts.ts";
import {
  IntFromString,
  type Login,
  type ObjectId,
  type RepoFacts,
  type RepoName,
  type RepoNodeId,
  type Star,
} from "./schemas.ts";
import * as StarList from "./star-list.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";

const MAX_RETRY_WAIT = Duration.minutes(1);
const MAX_RETRIES = 3;

const ReadmeEntry = Schema.Struct({ etag: Schema.String, value: Schema.String });

const graphQLErrorType = /^[A-Z_]{1,40}$/;

const decodeRetryAfter = Schema.decodeUnknownOption(Schema.Struct({ "retry-after": IntFromString }));

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
    readonly stars: (login: Login) => Stream.Stream<Star, GitHubError>;
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
    Option.map(decodeRetryAfter(reply.headers), (headers) => headers["retry-after"] * 1000),
    () =>
      Option.flatMap(reply.rateLimit, (limit) =>
        limit.remaining === 0 ? Option.some(Math.max(0, limit.resetAt - now)) : Option.none(),
      ),
  );

// GitHub asks for a one minute wait on a rate limit that names no reset time.
const rateLimited = (endpoint: Endpoint, reply: TokenGate.Reply, now: number) =>
  new RateLimited({
    operation: endpoint.operation,
    resource: Option.match(reply.rateLimit, {
      onNone: () => TokenBudget.resourceOf(endpoint.path),
      onSome: (limit) => limit.resource,
    }),
    retryAfterMillis: Option.getOrElse(rateLimitWait(reply, now), () => 60_000),
  });

const classify = (endpoint: Endpoint, reply: TokenGate.Reply, now: number): GitHubError | undefined => {
  if ((reply.status >= 200 && reply.status < 300) || reply.status === 304) return undefined;
  if (reply.status === 401) return new Unauthorized({ operation: endpoint.operation });
  if (reply.status === 404) return new NotFound({ operation: endpoint.operation, path: endpoint.path });
  if (reply.status === 429 || (reply.status === 403 && Option.isSome(rateLimitWait(reply, now)))) {
    return rateLimited(endpoint, reply, now);
  }
  return new GitHubRequestFailed({ ...endpoint, status: reply.status, reason: "status" });
};

const make = Effect.gen(function* () {
  const gate = yield* TokenGate.TokenGate;
  const readmes = KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, "github/readme/"),
    ReadmeEntry,
  );

  const exchange = <A>(
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
    interpret: (
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
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const error = classify(endpoint, reply, now);
            return error === undefined ? interpret(reply, endpoint, now) : Effect.fail(error);
          }),
        ),
        Effect.catchTags({
          SchemaError: () => Effect.fail(new GitHubResponseInvalid({ ...endpoint, reason: "schema-mismatch" })),
        }),
        Effect.retry({ schedule: retrySchedule, while: isRetryable, times: MAX_RETRIES }),
      );
  };

  const starPage = Effect.fn("GitHub.starPage")(function* (login: Login, page: number) {
    return yield* exchange("list-stars", StarList.request(login, page), (reply, endpoint) =>
      Effect.gen(function* () {
        const items = yield* StarList.decodeStarItems(reply.body);
        const next = StarList.nextPage(reply.headers.link);
        if (Result.isFailure(next)) return yield* new GitHubResponseInvalid({ ...endpoint, reason: "invalid-link" });
        return [items.map(StarList.toStar), next.success] as const;
      }),
    );
  });

  const stars = (login: Login) => Stream.paginate(1, (page: number) => starPage(login, page));

  const factsBatch = Effect.fn("GitHub.factsBatch")(function* (ids: ReadonlyArray<RepoNodeId>) {
    return yield* exchange("repo-facts", Facts.request(ids), (reply, endpoint, now) =>
      Effect.gen(function* () {
        const body = yield* Facts.decodeResponse(reply.body);
        const errors = (body.errors ?? []).filter((error) => error.type !== "NOT_FOUND");
        if (errors.some((error) => error.type === "RATE_LIMITED")) return yield* rateLimited(endpoint, reply, now);
        if (errors.length > 0 || !body.data) {
          yield* Effect.logWarning("GitHub GraphQL errors", {
            count: errors.length,
            types: errors.flatMap((error) =>
              error.type !== undefined && graphQLErrorType.test(error.type) ? [error.type] : [],
            ),
          });
          return yield* new GitHubRequestFailed({ ...endpoint, status: null, reason: "graphql-errors" });
        }
        return body.data.nodes.flatMap((node) => (node === null ? [] : [Facts.toFacts(node)]));
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
    const request = Readme.request(input);
    const cached = yield* readmes
      .get(request.url)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("GitHub ETag cache read failed", { error: error.message }).pipe(Effect.as(Option.none())),
        ),
      );
    const reply = yield* exchange(
      "readme",
      Option.isSome(cached) ? HttpClientRequest.setHeader(request, "if-none-match", cached.value.etag) : request,
      Effect.succeed,
    );
    if (reply.status === 304 && Option.isSome(cached)) return cached.value.value;
    const etag = reply.headers.etag;
    if (etag !== undefined) {
      yield* readmes
        .set(request.url, { etag, value: reply.body })
        .pipe(Effect.catch((error) => Effect.logWarning("GitHub ETag cache write failed", { error: error.message })));
    }
    return reply.body;
  });

  return GitHub.of({ stars, repoFacts, readme });
});

export const layer = Layer.effect(GitHub, make);
