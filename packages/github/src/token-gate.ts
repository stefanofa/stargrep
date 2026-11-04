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
import * as Semaphore from "effect/Semaphore";
import { GitHubRequestFailed, type Operation, TokenBudgetExhausted } from "./errors.ts";
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
