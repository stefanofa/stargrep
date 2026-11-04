import { QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as AiRuntime from "@stargrep/runtime/ai";
import * as DbRuntime from "@stargrep/runtime/db";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { layerSearchCache, layerSyncLimiter, layerSyncQueue, layerSyncRequestLog } from "./adapters.ts";
import type { WebEnv } from "./env.ts";
import type { Timing } from "./serve.ts";

// Search makes at most two queries in a row, and each request opens its own pool.
const maxDatabaseConnections = 2;

const adopted = Ref.makeUnsafe(false);

const layerTimedSearch = (timing: Timing) =>
  Layer.effect(
    Search.Search,
    Effect.gen(function* () {
      const search = yield* Search.Search;
      return Search.Search.of({
        // Search.search opens its own span, so this wrapper adds none.
        search: Effect.fnUntraced(function* (request: Search.SearchRequest) {
          const [duration, outcome] = yield* Effect.timed(search.search(request));
          timing.search = Duration.toMillis(duration);
          return outcome;
        }),
      });
    }),
  ).pipe(Layer.provide(Search.layer));

export const layerRequest = (env: WebEnv, request: Request, timing: Timing) =>
  Layer.unwrap(
    Effect.map(
      AiRuntime.aiGatewayKey.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ),
      (key) =>
        Layer.mergeAll(
          layerTimedSearch(timing),
          SyncRequests.layer,
          layerSyncLimiter(
            { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
            request.headers.get("cf-connecting-ip") ?? "unknown",
          ),
        ).pipe(
          Layer.provideMerge(QueryPlanner.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              layerSearchCache(env.SEARCH_CACHE),
              layerSyncQueue(env.SYNC_STARS),
              layerSyncRequestLog(env.SYNC_REQUESTS),
            ),
          ),
          Layer.provideMerge(
            DbRuntime.layerDb({
              connectionString: Redacted.make(env.DATABASE.connectionString),
              adopted,
              maxConnections: maxDatabaseConnections,
            }),
          ),
          Layer.provideMerge(AiRuntime.layerSearch(key)),
        ),
    ),
  );
