import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
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

const MAX_RETRY_WAIT = Duration.minutes(1);
const MAX_RETRIES = 3;

const ReadmeEntry = Schema.Struct({ etag: Schema.String, value: Schema.String });

const graphQLErrorType = /^[A-Z_]{1,40}$/;

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

const endpoint = (request: HttpClientRequest.HttpClientRequest) => ({
  method: request.method,
  path: new URL(request.url).pathname,
});

const classify = Effect.fnUntraced(function* (operation: Operation, response: HttpClientResponse.HttpClientResponse) {
  if ((response.status >= 200 && response.status < 300) || response.status === 304) return response;
  if (response.status === 401) return yield* new Unauthorized({ operation });
  if (response.status === 404) return yield* new NotFound({ operation, path: endpoint(response.request).path });
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
    ...endpoint(response.request),
    status: response.status,
    reason: "status",
  });
});

const make = Effect.gen(function* () {
  const gate = yield* TokenGate.TokenGate;
  const readmes = KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, "github/readme/"),
    ReadmeEntry,
  );

  const exchange = <A>(
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
    read: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, GitHubError | HttpClientError.HttpClientError | Schema.SchemaError>,
  ) =>
    gate
      .execute(
        operation,
        request.pipe(HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" })),
        (response) =>
          Effect.flatMap(classify(operation, response), read).pipe(
            Effect.catchTags({
              SchemaError: () =>
                Effect.fail(new GitHubResponseInvalid({ operation, ...endpoint(request), reason: "schema-mismatch" })),
            }),
          ),
      )
      .pipe(Effect.retry({ schedule: retrySchedule, while: isRetryable, times: MAX_RETRIES }));

  const starPage = Effect.fn("GitHub.starPage")(function* (login: Login, page: number) {
    const request = StarList.request(login, page);
    return yield* exchange("list-stars", request, (response) =>
      Effect.gen(function* () {
        const items = yield* StarList.decodeStarItems(yield* response.json);
        const next = StarList.nextPage(response.headers.link);
        if (Result.isFailure(next)) {
          return yield* new GitHubResponseInvalid({
            operation: "list-stars",
            ...endpoint(request),
            reason: "invalid-link",
          });
        }
        return StarList.toPage(items, next.success);
      }),
    );
  });

  const stars = (login: Login) =>
    Stream.paginate(1, (page: number) =>
      starPage(login, page).pipe(Effect.map((result) => [result.stars, Option.fromNullOr(result.next)] as const)),
    );

  const factsBatch = Effect.fn("GitHub.factsBatch")(function* (ids: ReadonlyArray<RepoNodeId>) {
    const request = Facts.request(ids);
    return yield* exchange("repo-facts", request, (response) =>
      Effect.gen(function* () {
        const body = yield* Facts.decodeResponse(yield* response.json);
        const errors = (body.errors ?? []).filter((error) => error.type !== "NOT_FOUND");
        if (errors.some((error) => error.type === "RATE_LIMITED")) {
          return yield* new RateLimited({
            operation: "repo-facts",
            resource: "graphql",
            retryAfterMillis: rateLimitWait(response, yield* Clock.currentTimeMillis) ?? 60_000,
          });
        }
        if (errors.length > 0 || !body.data) {
          yield* Effect.logWarning("GitHub GraphQL errors", {
            count: errors.length,
            types: errors.flatMap((error) =>
              error.type !== undefined && graphQLErrorType.test(error.type) ? [error.type] : [],
            ),
          });
          return yield* new GitHubRequestFailed({
            operation: "repo-facts",
            ...endpoint(request),
            status: response.status,
            reason: "graphql-errors",
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
    const request = Readme.request(input);
    const cached = yield* readmes
      .get(request.url)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("GitHub ETag cache read failed", { error: error.message }).pipe(Effect.as(Option.none())),
        ),
      );
    const fetched = yield* exchange(
      "readme",
      Option.isSome(cached) ? HttpClientRequest.setHeader(request, "if-none-match", cached.value.etag) : request,
      (response) =>
        response.status === 304 && Option.isSome(cached)
          ? Effect.succeed({ text: cached.value.value, etag: undefined })
          : Effect.map(response.text, (text) => ({ text, etag: response.headers.etag })),
    );
    if (fetched.etag !== undefined) {
      yield* readmes
        .set(request.url, { etag: fetched.etag, value: fetched.text })
        .pipe(Effect.catch((error) => Effect.logWarning("GitHub ETag cache write failed", { error: error.message })));
    }
    return fetched.text;
  });

  return GitHub.of({ stars, repoFacts, readme });
});

export const layer = Layer.effect(GitHub, make);
