import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { app } from "./alchemy.run.ts";

export interface Resource {
  readonly Type: string;
  readonly RemovalPolicy: string;
  readonly Props: { readonly env: Readonly<Record<string, unknown>>; readonly forceDestroy?: boolean };
  readonly RuntimeContext: { readonly env: Readonly<Record<string, unknown>> };
}

// Runs the app stack the way a deploy plans it, without touching any cloud.
export const declare = Effect.fn("declare")(function* (stage: string, env: Readonly<Record<string, string>>) {
  const resources: Record<string, Resource> = {};
  const output: { readonly aiProvider?: string } = yield* app.pipe(
    Effect.provideService(Alchemy.Stack, { name: "Stargrep", stage, resources, bindings: {}, actions: {} } as never),
    Effect.provideService(Cloudflare.Providers, {} as never),
    Effect.provideService(Neon.Providers, {} as never),
    Effect.provideService(GitHub.Providers, {} as never),
    Effect.provide(Alchemy.RandomProvider()),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );
  return { resources, output };
});

export const previewEnv = { AI_GATEWAY_API_KEY: "test-ai-key", STARGREP_GITHUB_TOKEN: "test-pat", PULL_REQUEST: "7" };

export const prodEnv = {
  AI_GATEWAY_API_KEY: "test-ai-key",
  STARGREP_GITHUB_SERVER_TOKEN: "app",
  STARGREP_GITHUB_APP_PRIVATE_KEY: "test-app-key",
  STARGREP_GITHUB_APP_CLIENT_ID: "test-client-id",
  STARGREP_GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  BETTER_AUTH_SECRET: "test-auth-secret",
  AUTH_PROXY_SECRET: "test-proxy-secret",
};
