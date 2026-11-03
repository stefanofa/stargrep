import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { TokenBudgetExhausted } from "./errors.ts";
import { type BudgetShare, RateLimitHeaders } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";

const decodeRateLimitHeaders = Schema.decodeUnknownOption(RateLimitHeaders);

const EXCHANGE_TIMEOUT = Duration.seconds(30);

export class TokenGate extends Context.Service<
  TokenGate,
  {
    readonly execute: <A, E>(
      request: HttpClientRequest.HttpClientRequest,
      read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | HttpClientError.HttpClientError | Cause.TimeoutError | TokenBudgetExhausted>;
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

      const execute = Effect.fn("TokenGate.execute")(function* <A, E>(
        request: HttpClientRequest.HttpClientRequest,
        read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
      ) {
        const resource = TokenBudget.resourceOf(request.url);
        const decision = TokenBudget.check(yield* Ref.get(budget), resource, yield* Clock.currentTimeMillis);
        if (decision._tag === "Exhausted") {
          return yield* new TokenBudgetExhausted({ resource, resetAt: decision.resetAt });
        }
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* client.execute(HttpClientRequest.bearerToken(request, options.token));
            const headers = decodeRateLimitHeaders(response.headers);
            if (Option.isSome(headers)) {
              yield* Ref.update(budget, (current) =>
                TokenBudget.observe(current, {
                  resource: headers.value["x-ratelimit-resource"],
                  limit: headers.value["x-ratelimit-limit"],
                  remaining: headers.value["x-ratelimit-remaining"],
                  resetAt: headers.value["x-ratelimit-reset"] * 1000,
                }),
              );
            }
            return yield* read(response);
          }),
        ).pipe(Effect.timeout(EXCHANGE_TIMEOUT));
      }, permit.withPermit);

      return TokenGate.of({ execute, budget: Ref.get(budget) });
    }),
  );
