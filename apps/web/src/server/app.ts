import { env, waitUntil } from "cloudflare:workers";
import type { PublicConfig } from "@stargrep/api/contract";
import { publicConfig } from "@stargrep/api/public-config";
import { type AuthConfig, authConfig } from "@stargrep/auth/config";
import type { BudgetShare } from "@stargrep/github/schemas";
import { budgetShare } from "@stargrep/runtime/budget-share";
import { aiGatewayKey } from "@stargrep/runtime/config";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { makeAnswerCache } from "./answer-cache.ts";
import type { DeclaredEnv } from "./env.ts";
import { workerCache } from "./icons.ts";
import { layerAuthRequest, layerRequest } from "./layers.ts";
import { makeAuthServer, makeServer } from "./serve.ts";

export const bindings = env as DeclaredEnv;

// TanStack Start's dev server loads this module outside a request, where env is still empty, so config is read on first use.
let config: {
  readonly aiKey: Option.Option<Redacted.Redacted<string>>;
  readonly budgetShare: BudgetShare;
  readonly auth: Option.Option<AuthConfig>;
  readonly site: PublicConfig;
};
const readConfig = () => {
  config ??= Effect.runSync(
    Effect.all({ aiKey: aiGatewayKey, budgetShare, auth: authConfig, site: publicConfig }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings)),
    ),
  );
  return config;
};

export const serveAuth = makeAuthServer((request) => {
  const { aiKey, budgetShare, auth } = readConfig();
  return Option.map(auth, (signIn) => layerAuthRequest(bindings, aiKey, budgetShare, signIn, request));
}, Tracing.tracer);

const layerForRequest = (request: Request) => {
  const { aiKey, budgetShare, auth } = readConfig();
  return layerRequest(bindings, aiKey, budgetShare, auth, request);
};

export const serveApi = makeServer({
  layerFor: layerForRequest,
  tracer: Tracing.tracer,
  publicConfig: () => readConfig().site,
  answerCache: makeAnswerCache(() => Promise.resolve(workerCache())),
  waitUntil,
});
