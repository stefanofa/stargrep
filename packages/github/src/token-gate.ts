import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpMethod from "effect/http/HttpMethod";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitHubRequestFailed, GitHubTokenMissing, Operation, TokenBudgetExhausted } from "./errors.ts";
import { BudgetShare, IntFromString } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";

const EXCHANGE_TIMEOUT = Duration.seconds(30);

const decodeInt = Schema.decodeUnknownOption(IntFromString);

export type RateLimitHeaders = {
  readonly resource: Option.Option<string>;
  readonly limit: Option.Option<number>;
  readonly remaining: Option.Option<number>;
  readonly resetAt: Option.Option<number>;
};

const rateLimitHeaders = (headers: Headers.Headers): RateLimitHeaders => ({
  resource: Option.fromUndefinedOr(headers["x-ratelimit-resource"]),
  limit: decodeInt(headers["x-ratelimit-limit"]),
  remaining: decodeInt(headers["x-ratelimit-remaining"]),
  resetAt: Option.map(decodeInt(headers["x-ratelimit-reset"]), (seconds) => seconds * 1000),
});

export const hasBody = (status: number) => status >= 200 && status < 300;

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
    ) => Effect.Effect<Reply, GitHubRequestFailed | TokenBudgetExhausted | GitHubTokenMissing>;
    readonly budget: Effect.Effect<TokenBudget.Budget>;
  }
>()("@stargrep/github/token-gate/TokenGate") {}

const endpointOf = (operation: Operation, request: HttpClientRequest.HttpClientRequest) => ({
  operation,
  method: request.method,
  path: new URL(request.url).pathname,
});

export const layerMemory = (options: {
  readonly token: Redacted.Redacted<string>;
  readonly share: BudgetShare;
  readonly budget?: TokenBudget.Budget | undefined;
}) =>
  Layer.effect(
    TokenGate,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const permit = yield* Semaphore.make(1);
      const budget = yield* Ref.make(options.budget ?? TokenBudget.make(options.share));

      const execute = Effect.fn("TokenGate.execute")(function* (
        operation: Operation,
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const endpoint = endpointOf(operation, request);
        yield* Effect.annotateCurrentSpan({ "http.request.method": endpoint.method, "url.path": endpoint.path });
        const resource = TokenBudget.resourceOf(endpoint.path);
        const decision = TokenBudget.check(yield* Ref.get(budget), resource, yield* Clock.currentTimeMillis);
        if (decision._tag === "Exhausted") {
          return yield* new TokenBudgetExhausted({ resource, resetAt: decision.resetAt });
        }
        const reply = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* client.execute(HttpClientRequest.bearerToken(request, options.token));
            const rateLimit = rateLimitHeaders(response.headers);
            const observed = Option.all(rateLimit);
            if (Option.isSome(observed)) {
              yield* Ref.update(budget, (current) => TokenBudget.observe(current, observed.value));
            }
            const body = hasBody(response.status) ? yield* Effect.option(response.text) : Option.none();
            return { status: response.status, headers: response.headers, body, rateLimit };
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: EXCHANGE_TIMEOUT,
            orElse: () => Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "timeout" })),
          }),
          Effect.catchTags({
            HttpClientError: () =>
              Effect.fail(new GitHubRequestFailed({ ...endpoint, status: null, reason: "transport" })),
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        );
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": reply.status });
        return reply;
      }, permit.withPermit);

      return TokenGate.of({ execute, budget: Ref.get(budget) });
    }),
  );

export const layerMissing = Layer.succeed(
  TokenGate,
  TokenGate.of({
    execute: Effect.fn("TokenGate.execute")(function* (operation: Operation) {
      return yield* new GitHubTokenMissing({ operation });
    }),
    budget: Effect.succeed(TokenBudget.make(BudgetShare.make(1))),
  }),
);

// A gate that runs elsewhere, such as in a Durable Object, receives requests and returns results as plain
// data. The request carries no token, because the remote gate adds its own.
const StringRecord = Schema.Record(Schema.String, Schema.String);

export const RemoteRequest = Schema.Struct({
  operation: Operation,
  method: Schema.String.pipe(Schema.refine(HttpMethod.isHttpMethod)),
  url: Schema.String,
  headers: StringRecord,
  body: Schema.NullOr(Schema.Struct({ contentType: Schema.String, text: Schema.String })),
});
export type RemoteRequest = typeof RemoteRequest.Type;

export const RemoteResult = Schema.Union([
  Schema.TaggedStruct("Replied", { status: Schema.Int, headers: StringRecord, body: Schema.NullOr(Schema.String) }),
  GitHubRequestFailed,
  TokenBudgetExhausted,
  GitHubTokenMissing,
]);
export type RemoteResult = typeof RemoteResult.Type;

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

export const layerRemote = (remote: {
  readonly execute: (request: RemoteRequest) => Effect.Effect<unknown>;
  readonly budget: Effect.Effect<TokenBudget.Budget>;
}) =>
  Layer.succeed(
    TokenGate,
    TokenGate.of({
      execute: Effect.fn("TokenGate.execute")(function* (
        operation: Operation,
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const endpoint = endpointOf(operation, request);
        const sent = yield* toRemoteRequest(operation, request);
        // A failed RPC call reaches here as a failure the stub's type does not name, or as a defect.
        const exit = yield* Effect.exit(Effect.flatMap(remote.execute(sent), decodeRemoteResult));
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
      budget: remote.budget,
    }),
  );
