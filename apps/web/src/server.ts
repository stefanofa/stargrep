import { env } from "cloudflare:workers";
import { aiGatewayKey } from "@stargrep/runtime/config";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import start from "@tanstack/react-start/server-entry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type { DeclaredEnv } from "./server/env.ts";
import { withHealth } from "./server/health.ts";
import { layerRequest } from "./server/layers.ts";
import { makeServer } from "./server/serve.ts";

const bindings = env as DeclaredEnv;

// TanStack Start's dev server loads this module outside a request, where env is still empty, so the key is read on first use.
let aiKey: Option.Option<Redacted.Redacted<string>> | undefined;
const readAiKey = () =>
  Effect.runSync(
    aiGatewayKey.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings))),
  );

const serve = makeServer((request) => {
  aiKey ??= readAiKey();
  return layerRequest(bindings, aiKey, request);
}, Tracing.tracer);

export default {
  fetch: withHealth(bindings, (request) => serve(request) ?? start.fetch(request)),
};
