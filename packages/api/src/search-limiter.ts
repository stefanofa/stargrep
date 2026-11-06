import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SearchRateLimited extends Schema.TaggedError<SearchRateLimited, { readonly brand: unique symbol }>()(
  "SearchRateLimited",
  {},
) {
  override get message(): string {
    return "Searches from this network are over the rate limit";
  }
}

export class SearchLimiterUnavailable extends Schema.TaggedError<
  SearchLimiterUnavailable,
  { readonly brand: unique symbol }
>()("SearchLimiterUnavailable", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The search rate limit could not be checked";
  }
}

export class SearchLimiter extends Context.Service<
  SearchLimiter,
  {
    readonly acquire: Effect.Effect<void, SearchRateLimited | SearchLimiterUnavailable>;
  }
>()("@stargrep/api/search-limiter/SearchLimiter") {}
