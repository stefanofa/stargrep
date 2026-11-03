import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
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
  type Login,
  type ObjectId,
  type RepoFacts,
  type RepoName,
  type RepoNodeId,
  RetryHeaders,
  type Star,
} from "./schemas.ts";
import * as StarList from "./star-list.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";

const REQUEST_TIMEOUT = Duration.seconds(30);
const MAX_RETRY_WAIT = Duration.minutes(1);
const MAX_RETRIES = 3;

const StarPageEntry = Schema.Struct({ etag: Schema.String, value: StarList.StarPage });
const ReadmeEntry = Schema.Struct({ etag: Schema.String, value: Schema.String });

const decodeRetryHeaders = Schema.decodeUnknownOption(RetryHeaders);

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<GitHubError>(),
  Schedule.modifyDelay(({ duration, input }) =>
    Effect.succeed(input._tag === "RateLimited" ? Duration.millis(input.retryAfterMillis) : duration),
  ),
);

const isRetryable = (error: GitHubError) => {
  switch (error._tag) {
    case "RateLimited":
      return error.retryAfterMillis <= Duration.toMillis(MAX_RETRY_WAIT);
    case "GitHubRequestFailed":
      return error.status === null || error.status >= 500;
    default:
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

// GitHub asks for a one minute wait on a 429 that has no retry-after.
const rateLimitWait = (response: HttpClientResponse.HttpClientResponse, now: number): number | undefined => {
  const headers = Option.getOrUndefined(decodeRetryHeaders(response.headers));
  if (headers?.["retry-after"] !== undefined) return headers["retry-after"] * 1000;
  if (headers?.["x-ratelimit-remaining"] === 0 && headers["x-ratelimit-reset"] !== undefined) {
    return Math.max(0, headers["x-ratelimit-reset"] * 1000 - now);
  }
  return response.status === 429 ? 60_000 : undefined;
};

const classify = Effect.fnUntraced(function* (operation: Operation, response: HttpClientResponse.HttpClientResponse) {
  if ((response.status >= 200 && response.status < 300) || response.status === 304) return response;
  if (response.status === 401) return yield* new Unauthorized({ operation });
  if (response.status === 404) return yield* new NotFound({ operation, path: new URL(response.request.url).pathname });
  if (response.status === 403 || response.status === 429) {
    const wait = rateLimitWait(response, yield* Clock.currentTimeMillis);
    if (wait !== undefined) {
      return yield* new RateLimited({
        operation,
        resource: TokenBudget.resourceOf(response.request.url),
        retryAfterMillis: wait,
      });
    }
  }
  return yield* new GitHubRequestFailed({
    operation,
    status: response.status,
    cause: new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request: response.request, response }),
    }),
  });
});

const make = Effect.gen(function* () {
  const gate = yield* TokenGate.TokenGate;
  const cache = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, "github/etag/");
  const starPages = KeyValueStore.toSchemaStore(cache, StarPageEntry);
  const readmes = KeyValueStore.toSchemaStore(cache, ReadmeEntry);

  const send = (operation: Operation, request: HttpClientRequest.HttpClientRequest) =>
    gate
      .execute(
        request.pipe(HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" })),
      )
      .pipe(
        Effect.catchTags({
          HttpClientError: (cause) => Effect.fail(new GitHubRequestFailed({ operation, status: null, cause })),
        }),
        Effect.flatMap((response) => classify(operation, response)),
      );

  const withRetry = <A>(operation: Operation, attempt: Effect.Effect<A, GitHubError>) =>
    attempt.pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new GitHubRequestFailed({ operation, status: null, cause: "timed out" })),
      }),
      Effect.retry({ schedule: retrySchedule, while: isRetryable, times: MAX_RETRIES }),
    );

  const getCached = Effect.fnUntraced(function* <A>(
    operation: Operation,
    store: Pick<
      KeyValueStore.SchemaStore<Schema.Codec<{ readonly etag: string; readonly value: A }, unknown>>,
      "get" | "set"
    >,
    request: HttpClientRequest.HttpClientRequest,
    parse: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, GitHubError>,
  ) {
    const key = `${request.url}?${UrlParams.toString(request.urlParams)}`;
    const cached = yield* store
      .get(key)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("GitHub ETag cache read failed", { error: error.message }).pipe(Effect.as(Option.none())),
        ),
      );
    const response = yield* send(
      operation,
      Option.isSome(cached) ? HttpClientRequest.setHeader(request, "if-none-match", cached.value.etag) : request,
    );
    if (response.status === 304 && Option.isSome(cached)) return cached.value.value;
    const value = yield* parse(response);
    const etag = response.headers.etag;
    if (etag !== undefined) {
      yield* store
        .set(key, { etag, value })
        .pipe(Effect.catch((error) => Effect.logWarning("GitHub ETag cache write failed", { error: error.message })));
    }
    return value;
  });

  const starPage = Effect.fn("GitHub.starPage")(function* (login: Login, page: number) {
    return yield* withRetry(
      "list-stars",
      getCached("list-stars", starPages, StarList.request(login, page), (response) =>
        response.json.pipe(
          Effect.flatMap(StarList.decodeStarItems),
          Effect.map((items) => StarList.toPage(items, response.headers.link)),
          Effect.mapError((cause) => new GitHubResponseInvalid({ operation: "list-stars", cause })),
        ),
      ),
    );
  });

  const stars = (login: Login) =>
    Stream.paginate(1, (page: number) =>
      starPage(login, page).pipe(Effect.map((result) => [result.stars, Option.fromNullOr(result.next)] as const)),
    );

  const factsBatch = Effect.fn("GitHub.factsBatch")(function* (ids: ReadonlyArray<RepoNodeId>) {
    return yield* withRetry(
      "repo-facts",
      Effect.gen(function* () {
        const response = yield* send("repo-facts", Facts.request(ids));
        const body = yield* response.json.pipe(
          Effect.flatMap(Facts.decodeResponse),
          Effect.mapError((cause) => new GitHubResponseInvalid({ operation: "repo-facts", cause })),
        );
        const errors = (body.errors ?? []).filter((error) => error.type !== "NOT_FOUND");
        if (errors.some((error) => error.type === "RATE_LIMITED")) {
          return yield* new RateLimited({
            operation: "repo-facts",
            resource: "graphql",
            retryAfterMillis: rateLimitWait(response, yield* Clock.currentTimeMillis) ?? 60_000,
          });
        }
        if (errors.length > 0 || !body.data) {
          return yield* new GitHubRequestFailed({
            operation: "repo-facts",
            status: response.status,
            cause: errors.map((error) => error.type ?? "UNKNOWN"),
          });
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
    return yield* withRetry(
      "readme",
      getCached("readme", readmes, Readme.request(input), (response) =>
        response.text.pipe(Effect.mapError((cause) => new GitHubResponseInvalid({ operation: "readme", cause }))),
      ),
    );
  });

  return GitHub.of({ stars, repoFacts, readme });
});

export const layer = Layer.effect(GitHub, make);
