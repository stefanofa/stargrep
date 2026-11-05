import { env } from "cloudflare:workers";
import { type AuthConfig, authConfig } from "@stargrep/auth/config";
import { aiGatewayKey } from "@stargrep/runtime/config";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import start from "@tanstack/react-start/server-entry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type { DeclaredEnv } from "./server/env.ts";
import { withHealth } from "./server/health.ts";
import { serveIcon, workerCache } from "./server/icons.ts";
import { layerAuthRequest, layerRequest } from "./server/layers.ts";
import { makeAuthServer, makeServer } from "./server/serve.ts";

const bindings = env as DeclaredEnv;

// TanStack Start's dev server loads this module outside a request, where env is still empty, so config is read on first use.
let config: { readonly aiKey: Option.Option<Redacted.Redacted<string>>; readonly auth: Option.Option<AuthConfig> };
const readConfig = () => {
  config ??= Effect.runSync(
    Effect.all({ aiKey: aiGatewayKey, auth: authConfig }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings)),
    ),
  );
  return config;
};

const serveAuth = makeAuthServer((request) => {
  const { aiKey, auth } = readConfig();
  return Option.map(auth, (signIn) => layerAuthRequest(bindings, aiKey, signIn, request));
}, Tracing.tracer);

const serve = makeServer((request) => {
  const { aiKey, auth } = readConfig();
  return layerRequest(bindings, aiKey, auth, request);
}, Tracing.tracer);

export default {
  fetch: (request: Request, _env: unknown, context: ExecutionContext) =>
    withHealth(
      bindings,
      (incoming) =>
        serveIcon(incoming, {
          bucket: bindings.ICONS,
          cache: workerCache(),
          waitUntil: (promise) => context.waitUntil(promise),
        }) ??
        serveAuth(incoming) ??
        serve(incoming) ??
        start.fetch(incoming),
    )(request),
};
