import type { Search } from "@stargrep/core/search";
import type { SyncRequests } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Caller } from "./caller.ts";
import type { IconHost } from "./icon-host.ts";
import type { SearchLimiter } from "./search-limiter.ts";
import type { SyncLimiter } from "./sync-limiter.ts";
import type { Viewers } from "./viewers.ts";

export type ApiServices =
  | Db.Db
  | Search.Search
  | SyncRequests.SyncRequests
  | SyncLimiter
  | SearchLimiter
  | Viewers
  | IconHost
  | Caller;

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

// Built at most once per request, and only when a procedure asks, so a bad request or a cached answer builds none.
export type BuildServices = Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>;

export const withServices = <A, E>(services: BuildServices, run: Effect.Effect<A, E, ApiServices>) =>
  Effect.flatMap(services, (built) => Effect.provideContext(run, built));
