import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class SyncLimiter extends Context.Service<
  SyncLimiter,
  {
    readonly allow: Effect.Effect<boolean>;
  }
>()("@stargrep/api/sync-limiter/SyncLimiter") {}
