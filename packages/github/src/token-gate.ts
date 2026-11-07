import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpMethod from "effect/http/HttpMethod";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitHubRequestFailed, GitHubTokenMissing, Operation, RateLimited, TokenBudgetExhausted } from "./errors.ts";
import { type BudgetShare, IntFromString } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";

const EXCHANGE_TIMEOUT = Duration.seconds(30);

const decodeInt = Schema.decodeUnknownOption(IntFromString);

export type RateLimitHeaders = {
  readonly resource: Option.Option<string>;
  readonly limit: Option.Option<number>;
  readonly remaining: Option.Option<number>;
  readonly resetAt: Option.Option<number>;
};

export const rateLimitHeaders = (headers: Headers.Headers): RateLimitHeaders => ({
  resource: Option.fromUndefinedOr(headers["x-ratelimit-resource"]),
  limit: decodeInt(headers["x-ratelimit-limit"]),
  remaining: decodeInt(headers["x-ratelimit-remaining"]),
  resetAt: Option.map(decodeInt(headers["x-ratelimit-reset"]), (seconds) => seconds * 1000),
});

export const isSuccess = (status: number) => status >= 200 && status < 300;

const ERROR_BODY_LIMIT = 1024;

// GitHub names a secondary rate limit only in the message of a 403, so the gate keeps the start of that body. A 403 whose
// headers already name the wait needs no body, so a body that never arrives cannot hide the limit.
const readBody = (response: HttpClientResponse.HttpClientResponse) => {
  if (isSuccess(response.status)) return Effect.option(response.text);
  const named = response.headers["retry-after"] !== undefined || response.headers["x-ratelimit-remaining"] === "0";
  if (response.status !== 403 || named) return Effect.succeedNone;
  return Effect.option(Effect.map(response.text, (text) => text.slice(0, ERROR_BODY_LIMIT)));
};

export interface Reply {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly body: Option.Option<string>;
  readonly rateLimit: RateLimitHeaders;
}

export class TokenGate extends Context.Service<
  TokenGate,
  {
    readonly execute: (
      operation: Operation,
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<Reply, GitHubRequestFailed | TokenBudgetExhausted | GitHubTokenMissing | RateLimited>;
  }
>()("@stargrep/github/token-gate/TokenGate") {}

const endpointOf = (operation: Operation, request: HttpClientRequest.HttpClientRequest) => ({
  operation,
  method: request.method,
  path: new URL(request.url).pathname,
});

export interface Endpoint {
  readonly operation: Operation;
  readonly method: string;
  readonly path: string;
}

// One exchange with GitHub, its body read within the timeout. Its errors carry no request, so no credential reaches a
// span or a log. onHeaders sees the rate-limit headers before the body, which can still time out.
export const send = (
  client: HttpClient.HttpClient,
  endpoint: Endpoint,
  request: HttpClientRequest.HttpClientRequest,
  onHeaders: (rateLimit: RateLimitHeaders) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<Reply, GitHubRequestFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(client).execute(request);
      yield* onHeaders(rateLimitHeaders(response.headers));
      const body = yield* readBody(response);
      return {
        status: response.status,
        headers: response.headers,
        body,
        rateLimit: rateLimitHeaders(response.headers),
      };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: EXCHANGE_TIMEOUT,
      orElse: () => Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "timeout" })),
    }),
    Effect.catchTags({
      HttpClientError: () => Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "transport" })),
    }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );

// Where a gate's token comes from. A personal or user token is fixed. The App's installation token is minted and
// renewed, so a token GitHub rejects can be dropped for a new one.
export interface TokenSource {
  readonly current: (
    operation: Operation,
  ) => Effect.Effect<Redacted.Redacted<string>, GitHubRequestFailed | TokenBudgetExhausted | GitHubTokenMissing>;
  // Drops a token GitHub rejected, and answers whether a new one can be had.
  readonly rejected: Effect.Effect<boolean>;
}

export const fixed = (token: Redacted.Redacted<string>): TokenSource => ({
  current: () => Effect.succeed(token),
  rejected: Effect.succeed(false),
});

interface MemoryOptions {
  readonly share: BudgetShare;
  readonly windows?: TokenBudget.Windows | undefined;
}

// One request in flight and one budget, whichever token sends a request. GitHub counts every token of one user, or of
// one app installation, against the same limits, so a renewed token keeps the windows of the one it replaced. The token
// is read once a request holds the gate, so a request that waited never sends one that expired meanwhile.
export const makeMemory = Effect.fn("TokenGate.makeMemory")(function* (options: MemoryOptions) {
  const client = yield* HttpClient.HttpClient;
  const permit = yield* Semaphore.make(1);
  const budget = yield* Ref.make(TokenBudget.make(options.share, options.windows));

  const sendWith = Effect.fnUntraced(function* (
    source: TokenSource,
    endpoint: Endpoint,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* source.current(endpoint.operation);
    return yield* send(client, endpoint, HttpClientRequest.bearerToken(request, token), (rateLimit) => {
      const observed = Option.all(rateLimit);
      return Option.isSome(observed)
        ? Ref.update(budget, (current) => TokenBudget.observe(current, observed.value))
        : Effect.void;
    });
  });

  const execute = (source: TokenSource) =>
    Effect.fn("TokenGate.execute")(function* (operation: Operation, request: HttpClientRequest.HttpClientRequest) {
      const endpoint = endpointOf(operation, request);
      yield* Effect.annotateCurrentSpan({ "http.request.method": endpoint.method, "url.path": endpoint.path });
      const resource = TokenBudget.resourceOf(endpoint.path);
      const decision = TokenBudget.check(yield* Ref.get(budget), resource, yield* Clock.currentTimeMillis);
      if (decision._tag === "Exhausted") {
        return yield* new TokenBudgetExhausted({ resource, resetAt: decision.resetAt });
      }
      const first = yield* sendWith(source, endpoint, request);
      // GitHub revokes an installation's tokens when its App is installed again.
      const reply =
        first.status === 401 && (yield* source.rejected) ? yield* sendWith(source, endpoint, request) : first;
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": reply.status });
      return reply;
    }, permit.withPermit);

  return { execute, budget: Ref.get(budget) };
});

export const layerMemory = (options: MemoryOptions & { readonly token: Redacted.Redacted<string> }) =>
  Layer.effect(
    TokenGate,
    Effect.map(makeMemory(options), ({ execute }) => TokenGate.of({ execute: execute(fixed(options.token)) })),
  );

// Counts each request the gate sent to GitHub, the client's retries and requests that failed included. A request the
// gate refused for its budget or a missing token never left it.
export const counting = (gate: TokenGate["Service"], sent: Ref.Ref<number>) => {
  const count = Ref.update(sent, (total) => total + 1);
  return TokenGate.of({
    execute: Effect.fn("TokenGate.execute")(
      (operation: Operation, request: HttpClientRequest.HttpClientRequest) => gate.execute(operation, request),
      Effect.tap(() => count),
      Effect.tapError((error) => (error._tag === "GitHubRequestFailed" ? count : Effect.void)),
    ),
  });
};

export const layerMissing = Layer.succeed(
  TokenGate,
  TokenGate.of({
    execute: Effect.fn("TokenGate.execute")(function* (operation: Operation) {
      return yield* new GitHubTokenMissing({ operation });
    }),
  }),
);

const StringRecord = Schema.Record(Schema.String, Schema.String);

export const RemoteRequest = Schema.Struct({
  operation: Operation,
  method: Schema.String.pipe(Schema.refine(HttpMethod.isHttpMethod)),
  url: Schema.String,
  headers: StringRecord,
  body: Schema.NullOr(Schema.Struct({ contentType: Schema.String, text: Schema.String })),
});
export type RemoteRequest = typeof RemoteRequest.Type;

const RemoteResult = Schema.Union([
  Schema.TaggedStruct("Replied", { status: Schema.Int, headers: StringRecord, body: Schema.NullOr(Schema.String) }),
  GitHubRequestFailed,
  TokenBudgetExhausted,
  GitHubTokenMissing,
  RateLimited,
]);
type RemoteResult = typeof RemoteResult.Type;

const decodeRemoteRequest = Schema.decodeUnknownEffect(RemoteRequest);
const encodeRemoteResult = Schema.encodeEffect(RemoteResult);
const decodeRemoteResult = Schema.decodeUnknownEffect(RemoteResult);

const textDecoder = new TextDecoder();

const stringEntries = (headers: Headers.Headers) => Object.fromEntries(Object.entries(headers));

const toRemoteRequest = (operation: Operation, request: HttpClientRequest.HttpClientRequest) => {
  const { body, method } = request;
  if (!HttpMethod.isHttpMethod(method) || (body._tag !== "Empty" && body._tag !== "Uint8Array")) {
    return Effect.die(`A remote token gate cannot send ${method} with a ${body._tag} body`);
  }
  const query = UrlParams.toString(request.urlParams);
  return Effect.succeed<RemoteRequest>({
    operation,
    method,
    url: query === "" ? request.url : `${request.url}?${query}`,
    headers: stringEntries(request.headers),
    body: body._tag === "Uint8Array" ? { contentType: body.contentType, text: textDecoder.decode(body.body) } : null,
  });
};

const fromRemoteRequest = (request: RemoteRequest) => {
  const sent = HttpClientRequest.make(request.method)(request.url, { headers: request.headers });
  return request.body === null ? sent : HttpClientRequest.bodyText(sent, request.body.text, request.body.contentType);
};

export const serve = (gate: TokenGate["Service"]) =>
  Effect.fn("TokenGate.serve")(function* (input: unknown) {
    const request = yield* Effect.orDie(decodeRemoteRequest(input));
    const result = yield* gate.execute(request.operation, fromRemoteRequest(request)).pipe(
      Effect.map(
        (reply): RemoteResult => ({
          _tag: "Replied",
          status: reply.status,
          headers: stringEntries(reply.headers),
          body: Option.getOrNull(reply.body),
        }),
      ),
      Effect.catch(Effect.succeed),
    );
    return yield* Effect.orDie(encodeRemoteResult(result));
  });

export const remote = (stub: { readonly execute: (request: RemoteRequest) => Effect.Effect<unknown> }) =>
  TokenGate.of({
    execute: Effect.fn("TokenGate.execute")(function* (
      operation: Operation,
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const endpoint = endpointOf(operation, request);
      const sent = yield* toRemoteRequest(operation, request);
      // A failed RPC call reaches here as a failure the stub's type does not name, or as a defect.
      const exit = yield* Effect.exit(Effect.flatMap(stub.execute(sent), decodeRemoteResult));
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
      const result = Exit.isSuccess(exit)
        ? exit.value
        : new GitHubRequestFailed({ ...endpoint, status: null, reason: "transport" });
      if (result._tag !== "Replied") return yield* result;
      const headers = Headers.fromInput(result.headers);
      return {
        status: result.status,
        headers,
        body: Option.fromNullOr(result.body),
        rateLimit: rateLimitHeaders(headers),
      } satisfies Reply;
    }),
  });

export const layerRemote = (stub: { readonly execute: (request: RemoteRequest) => Effect.Effect<unknown> }) =>
  Layer.succeed(TokenGate, remote(stub));
