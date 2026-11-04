import * as Gateway from "@stargrep/ai/gateway";
import { QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as DbRuntime from "@stargrep/runtime/db";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { layerSearchCache, layerSyncLimiter, layerSyncQueue } from "./adapters.ts";
import type { WebEnv } from "./env.ts";

const maxDatabaseConnections = 2;

const adopted = Ref.makeUnsafe(false);

export const layerRequest = (env: WebEnv, aiKey: Option.Option<Redacted.Redacted<string>>, request: Request) =>
  Layer.mergeAll(
    Search.layer,
    SyncRequests.layer,
    layerSyncLimiter(
      { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
      request.headers.get("cf-connecting-ip") ?? "unknown",
    ),
  ).pipe(
    Layer.provideMerge(QueryPlanner.layer),
    Layer.provideMerge(Layer.merge(layerSearchCache(env.SEARCH_CACHE), layerSyncQueue(env.SYNC_STARS))),
    Layer.provideMerge(
      DbRuntime.layerDb({
        connectionString: Redacted.make(env.DATABASE.connectionString),
        adopted,
        maxConnections: maxDatabaseConnections,
      }),
    ),
    Layer.provideMerge(Gateway.layerSearchForKey(aiKey)),
  );
