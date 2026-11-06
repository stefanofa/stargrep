import * as Gateway from "@stargrep/ai/gateway";
import { Caller } from "@stargrep/api/caller";
import { IconHost } from "@stargrep/api/icon-host";
import type { AuthConfig } from "@stargrep/auth/config";
import { ModelAllowance, QueryPlanner, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import type { BudgetShare } from "@stargrep/github/schemas";
import * as DbRuntime from "@stargrep/runtime/db";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { layerSearchCache, layerSyncQueue } from "./adapters.ts";
import { layerCaller } from "./caller.ts";
import type { WebEnv } from "./env.ts";
import { layerOwnerLookup } from "./owner-lookup.ts";
import { layerRateLimiter } from "./rate-limiter.ts";
import { layerAuth, layerViewers } from "./viewers.ts";

const maxDatabaseConnections = 2;

const adopted = Ref.makeUnsafe(false);

const connectionString = (env: WebEnv) => Redacted.make(env.DATABASE.connectionString);

const layerStorage = (env: WebEnv, aiKey: Option.Option<Redacted.Redacted<string>>, budgetShare: BudgetShare) =>
  Layer.mergeAll(SyncRequests.layer(budgetShare), FetchHttpClient.layer).pipe(
    Layer.provideMerge(Layer.merge(layerSyncQueue(env.SYNC_STARS), layerOwnerLookup(env.WORKER))),
    Layer.provideMerge(
      DbRuntime.layerDb({ connectionString: connectionString(env), adopted, maxConnections: maxDatabaseConnections }),
    ),
    Layer.provideMerge(Gateway.layerSearchForKey(aiKey)),
  );

export const layerRequest = (
  env: WebEnv,
  aiKey: Option.Option<Redacted.Redacted<string>>,
  budgetShare: BudgetShare,
  auth: Option.Option<AuthConfig>,
  request: Request,
) =>
  Layer.mergeAll(
    Search.layer,
    layerRateLimiter(env),
    layerViewers(auth, request, connectionString(env)),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
  ).pipe(
    Layer.provideMerge(QueryPlanner.layer),
    Layer.provideMerge(layerSearchCache(env.SEARCH_CACHE)),
    Layer.provideMerge(Layer.unwrap(Caller.use(({ key }) => Effect.succeed(ModelAllowance.layerMetered(key))))),
    Layer.provideMerge(layerCaller(env.CALLER_KEY, request)),
    Layer.provideMerge(layerStorage(env, aiKey, budgetShare)),
  );

export const layerAuthRequest = (
  env: WebEnv,
  aiKey: Option.Option<Redacted.Redacted<string>>,
  budgetShare: BudgetShare,
  auth: AuthConfig,
  request: Request,
) =>
  layerAuth(auth, new URL(request.url).origin, connectionString(env)).pipe(
    Layer.provide(layerStorage(env, aiKey, budgetShare)),
  );
