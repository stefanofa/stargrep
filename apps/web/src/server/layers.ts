import * as Gateway from "@stargrep/ai/gateway";
import { IconHost } from "@stargrep/api/icon-host";
import type { AuthConfig } from "@stargrep/auth/config";
import { QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as DbRuntime from "@stargrep/runtime/db";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { layerSearchCache, layerSyncLimiter, layerSyncQueue } from "./adapters.ts";
import { callerAddress, layerCaller } from "./caller.ts";
import type { WebEnv } from "./env.ts";
import { layerOwnerLookup } from "./owner-lookup.ts";
import { layerPlannerAllowance, layerSearchLimiter } from "./search-limits.ts";
import { layerAuth, layerViewers } from "./viewers.ts";

const maxDatabaseConnections = 2;

const adopted = Ref.makeUnsafe(false);

const connectionString = (env: WebEnv) => Redacted.make(env.DATABASE.connectionString);

const layerStorage = (env: WebEnv, aiKey: Option.Option<Redacted.Redacted<string>>) =>
  Layer.mergeAll(SyncRequests.layer, FetchHttpClient.layer).pipe(
    Layer.provideMerge(Layer.merge(layerSyncQueue(env.SYNC_STARS), layerOwnerLookup(env.WORKER))),
    Layer.provideMerge(
      DbRuntime.layerDb({ connectionString: connectionString(env), adopted, maxConnections: maxDatabaseConnections }),
    ),
    Layer.provideMerge(Gateway.layerSearchForKey(aiKey)),
  );

export const layerRequest = (
  env: WebEnv,
  aiKey: Option.Option<Redacted.Redacted<string>>,
  auth: Option.Option<AuthConfig>,
  request: Request,
) =>
  Layer.mergeAll(
    Search.layer,
    layerSyncLimiter(
      { perCaller: env.SYNC_PER_CALLER, overall: env.SYNC_OVERALL },
      request.headers.get("cf-connecting-ip") ?? "unknown",
    ),
    layerSearchLimiter(env.SEARCH_PER_CALLER, callerAddress(request)),
    layerViewers(auth, request, connectionString(env)),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
    layerCaller(env.CALLER_KEY, request),
  ).pipe(
    Layer.provideMerge(QueryPlanner.layer),
    Layer.provideMerge(layerSearchCache(env.SEARCH_CACHE)),
    Layer.provideMerge(
      layerPlannerAllowance(
        { perCaller: env.PLANNER_PER_CALLER, overall: env.PLANNER_OVERALL },
        callerAddress(request),
      ),
    ),
    Layer.provideMerge(layerStorage(env, aiKey)),
  );

export const layerAuthRequest = (
  env: WebEnv,
  aiKey: Option.Option<Redacted.Redacted<string>>,
  auth: AuthConfig,
  request: Request,
) => layerAuth(auth, new URL(request.url).origin, connectionString(env)).pipe(Layer.provide(layerStorage(env, aiKey)));
