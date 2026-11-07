import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import type { Search } from "@stargrep/core/search";
import type { SyncRequests } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Caller } from "./caller.ts";
import type { IconHost } from "./icon-host.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { Viewers } from "./viewers.ts";

export type ApiServices = Db.Db | Search.Search | SyncRequests.SyncRequests | RateLimiter | Viewers | IconHost | Caller;

export class ApiServicesUnavailable extends Schema.TaggedError<
  ApiServicesUnavailable,
  { readonly brand: unique symbol }
>()("ApiServicesUnavailable", {
  failure: Schema.String,
}) {
  override get message(): string {
    return `The API services failed to start with ${this.failure}`;
  }
}

export const services = middlewareGen<
  { readonly serviceLayer: Layer.Layer<ApiServices, ApiServicesUnavailable> },
  WithEffectContext<ApiServices>
>(function* ({ context, next }) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const built = yield* Layer.build(context.serviceLayer);
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC erases downstream failures to unknown.
      return yield* next({ context: { "effect/context": built } });
    }),
  );
});
