import * as Gateway from "@stargrep/ai/gateway";
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
import type { WebEnv } from "./env.ts";
import { layerAuth, layerViewers } from "./viewers.ts";

const maxDatabaseConnections = 2;

const adopted = Ref.makeUnsafe(false);

const connectionString = (env: WebEnv) => Redacted.make(env.DATABASE.connectionString);

const layerStorage = (env: WebEnv, aiKey: Option.Option<Redacted.Redacted<string>>) =>
  Layer.mergeAll(SyncRequests.layer, FetchHttpClient.layer).pipe(
    Layer.provideMerge(layerSyncQueue(env.SYNC_STARS)),
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
    layerViewers(auth, request, connectionString(env)),
  ).pipe(
    Layer.provideMerge(QueryPlanner.layer),
    Layer.provideMerge(layerSearchCache(env.SEARCH_CACHE)),
    Layer.provideMerge(layerStorage(env, aiKey)),
  );

export const layerAuthRequest = (
  env: WebEnv,
  aiKey: Option.Option<Redacted.Redacted<string>>,
  auth: AuthConfig,
  request: Request,
) => layerAuth(auth, new URL(request.url).origin, connectionString(env)).pipe(Layer.provide(layerStorage(env, aiKey)));
