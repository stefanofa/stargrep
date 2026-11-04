import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SyncRateLimited extends Schema.TaggedError<SyncRateLimited, { readonly brand: unique symbol }>()(
  "SyncRateLimited",
  {
    limit: Schema.Literals(["caller", "overall"]),
  },
) {
  override get message(): string {
    return `Sync requests are over the ${this.limit} rate limit`;
  }
}

export class SyncLimiterUnavailable extends Schema.TaggedError<
  SyncLimiterUnavailable,
  { readonly brand: unique symbol }
>()("SyncLimiterUnavailable", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The sync rate limit could not be checked";
  }
}

export class SyncLimiter extends Context.Service<
  SyncLimiter,
  {
    readonly acquire: Effect.Effect<void, SyncRateLimited | SyncLimiterUnavailable>;
  }
>()("@stargrep/api/sync-limiter/SyncLimiter") {}
