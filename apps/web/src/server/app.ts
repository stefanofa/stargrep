import { env, waitUntil } from "cloudflare:workers";
import type { PublicConfig } from "@stargrep/api/contract";
import { publicConfig } from "@stargrep/api/public-config";
import { authConfig } from "@stargrep/auth/config";
import { aiGatewayKey } from "@stargrep/runtime/ai-key";
import { budgetShare } from "@stargrep/runtime/server-token";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeAnswerCache } from "./answer-cache.ts";
import type { DeclaredEnv } from "./env.ts";
import { workerCache } from "./icons.ts";
import { layerAuthRequest, layerRequest, type RequestConfig } from "./layers.ts";
import { makeAuthServer, makeServer } from "./serve.ts";

export const bindings = env as DeclaredEnv;

// TanStack Start's dev server loads this module outside a request, where env is still empty, so config is read on first use.
let config: RequestConfig & {
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
  return Option.map(auth, (signIn) => layerAuthRequest(bindings, { aiKey, budgetShare, auth: signIn }, request));
}, Tracing.tracer);

const layerForRequest = (request: Request) => {
  return layerRequest(bindings, readConfig(), request);
};

// The page keeps its first answers beside the API's answers.
export const answers = makeAnswerCache(() => Promise.resolve(workerCache()));

export { waitUntil };

export const serveApi = makeServer({
  layerFor: layerForRequest,
  tracer: Tracing.tracer,
  publicConfig: () => readConfig().site,
  answerCache: answers,
  waitUntil,
});
