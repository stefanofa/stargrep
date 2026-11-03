import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AiConfig from "./config.ts";
import * as Embeddings from "./embeddings.ts";
import * as Models from "./models.ts";
import * as TextGeneration from "./text-generation.ts";

const unusedSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("no process runs while building layers")),
);

const build = (env: Record<string, string>) =>
  Layer.build(AiConfig.layer.pipe(Layer.provide(unusedSpawner))).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("ai provider config", () => {
  it.effect("defaults to the gateway for both ports", () =>
    Effect.gen(function* () {
      const context = yield* build({ AI_GATEWAY_API_KEY: "test-key" });
      const services = yield* Effect.all([TextGeneration.TextGeneration, Embeddings.Embeddings]).pipe(
        Effect.provide(context),
      );
      expect(services[0].model).toBe(Models.summaryModel);
      expect(services[1].model).toEqual(Models.embeddingModel);
    }),
  );

  it.effect("refuses the claude code harness outside local mode", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(build({ AI_TEXT_PROVIDER: "claude-code", AI_GATEWAY_API_KEY: "test-key" }));
      expect(error).toBeInstanceOf(AiConfig.AiProviderNotAllowed);
      expect(error.message).toBe("AI provider 'claude-code' runs only when STARGREP_MODE is local");
    }),
  );

  it.effect("refuses the claude code harness in CI even when the mode says local", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        build({ AI_TEXT_PROVIDER: "claude-code", STARGREP_MODE: "local", CI: "true", AI_GATEWAY_API_KEY: "test-key" }),
      );
      expect(error.message).toBe("AI provider 'claude-code' never runs in CI");
    }),
  );

  it.effect("refuses fake embeddings outside local mode", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(build({ AI_EMBEDDINGS_PROVIDER: "fake", AI_GATEWAY_API_KEY: "test-key" }));
      expect(error.message).toBe("AI provider 'fake' runs only when STARGREP_MODE is local");
    }),
  );

  it.effect("allows the harness locally with fake embeddings and no gateway key", () =>
    Effect.gen(function* () {
      const context = yield* build({
        STARGREP_MODE: "local",
        AI_TEXT_PROVIDER: "claude-code",
        AI_EMBEDDINGS_PROVIDER: "fake",
        AI_CLAUDE_CODE_MODEL: "sonnet",
      });
      const textGeneration = yield* TextGeneration.TextGeneration.pipe(Effect.provide(context));
      expect(textGeneration.model).toBe("sonnet");
    }),
  );
});
