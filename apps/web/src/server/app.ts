import { env, waitUntil } from "cloudflare:workers";
import type { PublicConfig } from "@stargrep/api/contract";
import { publicConfig } from "@stargrep/api/public-config";
import { authConfig } from "@stargrep/auth/config";
import { aiSetup, searchModels } from "@stargrep/runtime/ai-key";
import * as AnalyticsLayer from "@stargrep/runtime/analytics";
import { budgetShare } from "@stargrep/runtime/server-token";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layerAnalytics } from "./analytics.ts";
import { makeAnswerCache } from "./answer-cache.ts";
import type { DeclaredEnv } from "./env.ts";
import { workerCache } from "./icons.ts";
import { layerAuthRequest, layerRequest, type RequestConfig } from "./layers.ts";
import { repoStars } from "./repo-stars.ts";
import { type AnalyticsFor, background, makeAuthServer, makeServer } from "./serve.ts";

export const bindings = env as DeclaredEnv;

// TanStack Start's dev server loads this module outside a request, where env is still empty, so config is read on first use.
let config: RequestConfig & {
  readonly site: PublicConfig;
  readonly stage: string;
};
const readConfig = () => {
  config ??= Effect.runSync(
    Effect.all({ ai: aiSetup, budgetShare, auth: authConfig, site: publicConfig, stage: AnalyticsLayer.stage }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings)),
    ),
  );
  return config;
};

const sendAfterResponse = (send: Effect.Effect<void>) => Effect.sync(() => waitUntil(Effect.runPromise(send)));

const analyticsFor: AnalyticsFor = (request) =>
  layerAnalytics(readConfig().stage, bindings.CALLER_KEY, sendAfterResponse)(request);

const afterResponse = background({ waitUntil, analytics: analyticsFor, tracer: Tracing.tracer });

// Logs a failure no Effect handler caught, such as a page loader's, which also sends it to analytics as an exception.
export const reportFailure = (
  message: string,
  fields: Readonly<Record<string, unknown>>,
  error: unknown,
  request?: Request,
) => Effect.runPromise(Effect.logError(message, fields, Cause.die(error)).pipe(Effect.provide(analyticsFor(request))));

export const serveAuth = makeAuthServer(
  (request) => {
    const { ai, budgetShare, auth } = readConfig();
    return Option.map(auth, (signIn) =>
      layerAuthRequest(bindings, { ai, budgetShare, auth: signIn }, request, afterResponse),
    );
  },
  Tracing.tracer,
  analyticsFor,
);

const layerForRequest = (request: Request) => {
  return layerRequest(bindings, readConfig(), request, afterResponse);
};

// The page keeps its first answers beside the API's answers.
export const answers = makeAnswerCache(
  () => Promise.resolve(workerCache()),
  () => searchModels(readConfig().ai),
);

export { waitUntil };

// The header's star count waits at most 750ms for GitHub on a miss, so a slow GitHub costs one page that much at most.
export const headerStars = (origin: string) =>
  Effect.runPromise(
    repoStars(origin, {
      worker: bindings.WORKER,
      cache: () => Promise.resolve(workerCache()),
      waitUntil,
      renderWait: Duration.millis(750),
    }),
  );

export const serveApi = makeServer({
  layerFor: layerForRequest,
  tracer: Tracing.tracer,
  analytics: analyticsFor,
  publicConfig: () => readConfig().site,
  answerCache: answers,
  waitUntil,
});
