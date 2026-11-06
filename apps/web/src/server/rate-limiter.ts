import { Caller } from "@stargrep/api/caller";
import { RateLimited, RateLimiter, RateLimiterUnavailable, type RateLimitKind } from "@stargrep/api/rate-limiter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface RateLimitBindings {
  readonly SYNC_PER_CALLER: RateLimit;
  readonly SYNC_OVERALL: RateLimit;
  readonly SEARCH_PER_CALLER: RateLimit;
  readonly STARS_PER_CALLER: RateLimit;
}

const limitOnce = (binding: RateLimit, key: string, limit: RateLimited["limit"]) =>
  Effect.tryPromise({
    try: () => binding.limit({ key }),
    catch: (cause) => new RateLimiterUnavailable({ cause }),
  }).pipe(Effect.flatMap(({ success }) => (success ? Effect.void : Effect.fail(new RateLimited({ limit })))));

// Workers rate limiting is a cheap first layer. Cloudflare counts each binding per location and only approximately, so
// it turns away most of a burst but is not a cap. The exact caps are lines in Postgres.
export const layerRateLimiter = (bindings: RateLimitBindings) =>
  Layer.effect(
    RateLimiter,
    Effect.gen(function* () {
      const { address } = yield* Caller;
      const limits: Readonly<
        Record<RateLimitKind, ReadonlyArray<Effect.Effect<void, RateLimited | RateLimiterUnavailable>>>
      > = {
        sync: [limitOnce(bindings.SYNC_PER_CALLER, address, "network"), limitOnce(bindings.SYNC_OVERALL, "all", "all")],
        search: [limitOnce(bindings.SEARCH_PER_CALLER, address, "network")],
        stars: [limitOnce(bindings.STARS_PER_CALLER, address, "network")],
      };
      return RateLimiter.of({
        acquire: Effect.fn("RateLimiter.acquire")(function* (kind: RateLimitKind) {
          yield* Effect.annotateCurrentSpan("rate_limit.kind", kind);
          for (const limit of limits[kind]) yield* limit;
        }),
      });
    }),
  );
