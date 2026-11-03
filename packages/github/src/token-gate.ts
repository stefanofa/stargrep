import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import { GitHubRequestFailed, type Operation, TokenBudgetExhausted } from "./errors.ts";
import { type BudgetShare, IntFromString, RateLimit } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";

const EXCHANGE_TIMEOUT = Duration.seconds(30);

const RateLimitFromHeaders = Schema.Struct({
  "x-ratelimit-resource": Schema.String,
  "x-ratelimit-limit": IntFromString,
  "x-ratelimit-remaining": IntFromString,
  "x-ratelimit-reset": IntFromString,
}).pipe(
  Schema.decodeTo(
    RateLimit,
    SchemaTransformation.transform({
      decode: (headers) => ({
        resource: headers["x-ratelimit-resource"],
        limit: headers["x-ratelimit-limit"],
        remaining: headers["x-ratelimit-remaining"],
        resetAt: headers["x-ratelimit-reset"] * 1000,
      }),
      encode: (rateLimit) => ({
        "x-ratelimit-resource": rateLimit.resource,
        "x-ratelimit-limit": rateLimit.limit,
        "x-ratelimit-remaining": rateLimit.remaining,
        "x-ratelimit-reset": rateLimit.resetAt / 1000,
      }),
    }),
  ),
);

const decodeRateLimit = Schema.decodeUnknownOption(RateLimitFromHeaders);

export interface Reply {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly body: string;
  readonly rateLimit: Option.Option<RateLimit>;
}

export class TokenGate extends Context.Service<
  TokenGate,
  {
    readonly execute: (
      operation: Operation,
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<Reply, GitHubRequestFailed | TokenBudgetExhausted>;
    readonly budget: Effect.Effect<TokenBudget.Budget>;
  }
>()("@stargrep/github/token-gate/TokenGate") {}

export const layerMemory = (options: { readonly token: Redacted.Redacted<string>; readonly share: BudgetShare }) =>
  Layer.effect(
    TokenGate,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const permit = yield* Semaphore.make(1);
      const budget = yield* Ref.make(TokenBudget.make(options.share));

      const execute = Effect.fn("TokenGate.execute")(function* (
        operation: Operation,
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const endpoint = { operation, method: request.method, path: new URL(request.url).pathname };
        yield* Effect.annotateCurrentSpan({ "http.request.method": endpoint.method, "url.path": endpoint.path });
        const resource = TokenBudget.resourceOf(endpoint.path);
        const decision = TokenBudget.check(yield* Ref.get(budget), resource, yield* Clock.currentTimeMillis);
        if (decision._tag === "Exhausted") {
          return yield* new TokenBudgetExhausted({ resource, resetAt: decision.resetAt });
        }
        const reply = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* client.execute(HttpClientRequest.bearerToken(request, options.token));
            const body = yield* response.text;
            return {
              status: response.status,
              headers: response.headers,
              body,
              rateLimit: decodeRateLimit(response.headers),
            };
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
        if (Option.isSome(reply.rateLimit)) {
          const rateLimit = reply.rateLimit.value;
          yield* Ref.update(budget, (current) => TokenBudget.observe(current, rateLimit));
        }
        return reply;
      }, permit.withPermit);

      return TokenGate.of({ execute, budget: Ref.get(budget) });
    }),
  );
