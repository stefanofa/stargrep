import { expect, spyOn, test } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import { apiKeyName } from "@stargrep/ai/gateway";
import * as Summarize from "@stargrep/ai/summarize";
import { aiProviderName, aiSetup, layerModels, layerSearch } from "@stargrep/runtime/ai-key";
import * as Output from "alchemy/Output";
import { unpackEnvValue } from "alchemy/RuntimeContext";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import { declare, previewEnv } from "./declare-app.ts";

const prodEnv = {
  AI_GATEWAY_API_KEY: "test-ai-key",
  STARGREP_GITHUB_SERVER_TOKEN: "app",
  STARGREP_GITHUB_APP_PRIVATE_KEY: "test-app-key",
  STARGREP_GITHUB_APP_CLIENT_ID: "test-client-id",
  STARGREP_GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  BETTER_AUTH_SECRET: "test-auth-secret",
  AUTH_PROXY_SECRET: "test-proxy-secret",
};

const aiNames: ReadonlyArray<string> = [apiKeyName, aiProviderName];

const plain = (value: unknown) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);
// The Worker reads a captured binding back the way its runtime does.
const bound = (packed: string) => plain(unpackEnvValue(packed));

// What the deploy would bind on each Worker. The main Worker binds what its init read through Config, and the web
// Worker binds its props.
const deploy = (stage: string, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { resources, output } = yield* declare(stage, env);
    const { Worker: worker, Web: web } = resources;
    if (worker === undefined || web === undefined) return yield* Effect.die("the stack declared no Worker or Web");
    const ai = (env: Readonly<Record<string, unknown>>) => Record.filter(env, (_, key) => aiNames.includes(key));
    const captured = yield* Effect.forEach(Record.toEntries(ai(worker.RuntimeContext.env)), ([key, value]) =>
      Effect.map(Output.evaluate(value, {}), (evaluated) => [key, bound(Redacted.value(evaluated as never))] as const),
    ).pipe(Effect.provideService(State.State, {} as never));
    return {
      worker: Object.fromEntries(captured),
      web: Record.map(ai(web.Props.env), plain),
      output: output.aiProvider,
    };
  }).pipe(Effect.runPromise);

test("a preview binds no AI key and answers with the fakes, even when its deploy has the key", async () => {
  const bound = await deploy("pr-7", previewEnv);
  expect(bound).toEqual({
    worker: { STARGREP_AI_PROVIDER: "fake" },
    web: { STARGREP_AI_PROVIDER: "fake" },
    output: "fake",
  });
});

test("a preview whose deploy opts in binds the key and calls the gateway", async () => {
  const bound = await deploy("pr-7", { ...previewEnv, STARGREP_AI_PROVIDER: "gateway" });
  const gateway = { STARGREP_AI_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "test-ai-key" };
  expect(bound).toEqual({ worker: gateway, web: gateway, output: "gateway" });
});

test("prod binds the key and no provider, whatever its deploy's environment asks for", async () => {
  for (const asked of [{}, { STARGREP_AI_PROVIDER: "fake" }]) {
    const bound = await deploy("prod", { ...prodEnv, ...asked });
    const gateway = { AI_GATEWAY_API_KEY: "test-ai-key" };
    expect(bound).toEqual({ worker: gateway, web: gateway, output: undefined });
  }
});

// Each Worker reads its config from its bindings, as it would at runtime.
const readBound = (bindings: Readonly<Record<string, unknown>>) =>
  aiSetup.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings)),
    Effect.runSync,
  );

test("a preview's Workers summarize, embed, and plan without a network call", async () => {
  const { worker, web } = await deploy("pr-7", previewEnv);
  const fetches = spyOn(globalThis, "fetch");
  const repo = {
    fullName: "ratatui/ratatui",
    description: "Terminal dashboards",
    topics: ["tui"],
    language: "Rust",
    readme: null,
  };
  const enriched = Effect.gen(function* () {
    const summary = yield* Summarize.summarize(repo);
    const [embedded] = yield* (yield* Embeddings.Embeddings).embed([summary.summary]);
    return { summary, dimensions: embedded?.vector.length };
  }).pipe(Effect.provide(layerModels(readBound(worker))));
  const searched = Effect.gen(function* () {
    const plan = yield* Effect.flip(Summarize.summarize(repo));
    const [embedded] = yield* (yield* Embeddings.Embeddings).embed(["terminal dashboards"]);
    return { planFailure: plan._tag, dimensions: embedded?.vector.length };
  }).pipe(Effect.provide(layerSearch(readBound(web))));
  expect(await Effect.runPromise(Effect.all([enriched, searched]))).toEqual([
    { summary: { summary: "Terminal dashboards", keywords: ["tui"], kind: "other" }, dimensions: 1024 },
    { planFailure: "AiKeyMissing", dimensions: 1024 },
  ]);
  expect(fetches).not.toHaveBeenCalled();
  fetches.mockRestore();
});
