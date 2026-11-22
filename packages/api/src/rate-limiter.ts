import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type RateLimitKind = "sync" | "search" | "stars";

export class RateLimited extends Schema.TaggedError<RateLimited, { readonly brand: unique symbol }>()("RateLimited", {
  limit: Schema.Literals(["network", "all", "account"]),
}) {
  override get message(): string {
    return `Requests are over the ${this.limit} rate limit`;
  }
}

export class RateLimiterUnavailable extends Schema.TaggedError<
  RateLimiterUnavailable,
  { readonly brand: unique symbol }
>()("RateLimiterUnavailable", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The rate limit could not be checked";
  }
}

// Turns away most of a burst of public calls before they cost anything. The exact caps live in Postgres.
export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    readonly acquire: (kind: RateLimitKind) => Effect.Effect<void, RateLimited | RateLimiterUnavailable>;
  }
>()("@stargrep/api/rate-limiter/RateLimiter") {}
