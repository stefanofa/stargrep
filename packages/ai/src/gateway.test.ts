import { describe, expect } from "bun:test";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import * as it from "@stargrep/testing";
import { APICallError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";
import * as Embeddings from "./embeddings.ts";
import * as Gateway from "./gateway.ts";
import * as Models from "./models.ts";
import * as Summarize from "./prompts/summarize.ts";
import * as TextGeneration from "./text-generation.ts";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const textResult = (text: string): GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: undefined, reasoning: undefined },
  },
  warnings: [],
});

const unused = () => {
  throw new Error("not used in this test");
};

const textLayer = (doGenerate: (options: CallOptions) => PromiseLike<GenerateResult>, model = "test/model") =>
  Gateway.layerTextGeneration(model).pipe(
    Layer.provide(
      Layer.succeed(
        Gateway.AiProvider,
        Gateway.AiProvider.of({ languageModel: () => new MockLanguageModelV4({ doGenerate }), embeddingModel: unused }),
      ),
    ),
  );

const repo: Summarize.RepoFacts = {
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["rust", "tui", "terminal"],
  language: "Rust",
  readme: "# Ratatui\n\nRatatui is a crate for building rich terminal user interfaces and dashboards.",
};

const validSummary: Summarize.RepoSummary = {
  summary: "A Rust library for building terminal user interfaces and dashboards.",
  keywords: ["tui", "terminal dashboard"],
  kind: "library",
};

describe("gateway text generation", () => {
  it.effect("decodes the model's JSON into the summary schema", () =>
    Summarize.summarize(repo).pipe(
      Effect.tap((summary) => Effect.sync(() => expect(summary).toEqual(validSummary))),
      Effect.provide(textLayer(async () => textResult(JSON.stringify(validSummary)))),
    ),
  );

  it.effect("fails with AiOutputInvalid when the model returns text that is not JSON", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(error.message).toBe(
        "Model 'test/model' returned output that does not match the expected shape in 'generate': the model did not return a JSON object",
      );
    }).pipe(Effect.provide(textLayer(async () => textResult("Sure! Here is the summary you asked for.")))),
  );

  it.effect("fails with AiOutputInvalid when the JSON does not match the schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(JSON.stringify(error)).not.toContain("spaceship");
    }).pipe(Effect.provide(textLayer(async () => textResult(JSON.stringify({ ...validSummary, kind: "spaceship" }))))),
  );

  it.effect("fails with AiTimeout and aborts the request once the clock passes 60 seconds", () => {
    let aborted = false;
    const layer = textLayer(
      (options) =>
        new Promise((_, reject) =>
          options.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(options.abortSignal?.reason);
          }),
        ),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(Summarize.summarize(repo)));
      yield* TestClock.adjust("59 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber))._tag).toBe("AiTimeout");
      expect(aborted).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiModelNotFound naming the model the gateway does not know", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiModelNotFound");
      expect(error.message).toBe("Model 'acme/nope' is not available from this provider");
    }).pipe(
      Effect.provide(
        textLayer(async () => {
          throw new GatewayModelNotFoundError({ message: "Model not found", modelId: "acme/nope" });
        }, "acme/nope"),
      ),
    ),
  );

  it.effect("fails with AiRequestFailed that keeps the status and drops the request body", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error.message).toBe("Model 'test/model' request failed in 'generate': AI_APICallError with status 502");
      expect(JSON.stringify(error)).not.toContain("SECRET");
    }).pipe(
      Effect.provide(
        textLayer(async () => {
          throw new APICallError({
            message: "upstream failed",
            url: "https://ai-gateway.vercel.sh/v1",
            requestBodyValues: { prompt: "SECRET README TEXT" },
            statusCode: 502,
          });
        }),
      ),
    ),
  );

  it.effect("counts the gateway's reported tokens per model", () => {
    const tokens = (direction: string) =>
      Metric.value(Metric.withAttributes(TextGeneration.tokensUsed, { model: "metered/model", direction }));
    return Effect.gen(function* () {
      const before = yield* tokens("output");
      yield* Summarize.summarize(repo);
      expect((yield* tokens("output")).count - before.count).toBe(20);
    }).pipe(Effect.provide(textLayer(async () => textResult(JSON.stringify(validSummary)), "metered/model")));
  });
});

describe("gateway embeddings", () => {
  it.effect("fails with AiOutputInvalid when the model ignores the requested size", () => {
    const provider = Gateway.AiProvider.of({
      languageModel: unused,
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2]), warnings: [] }),
        }),
    });
    return Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      expect((yield* Effect.flip(embeddings.embed(["one"])))._tag).toBe("AiOutputInvalid");
    }).pipe(
      Effect.provide(
        Gateway.layerEmbeddings({ id: "test/embed", dimensions: 64 }).pipe(
          Layer.provide(Layer.succeed(Gateway.AiProvider, provider)),
        ),
      ),
    );
  });
});

describe("gateway production layer", () => {
  it.effect("builds both ports from AI_GATEWAY_API_KEY and the chosen models", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Gateway.layer);
      const [textGeneration, embeddings] = yield* Effect.all([
        TextGeneration.TextGeneration,
        Embeddings.Embeddings,
      ]).pipe(Effect.provide(context));
      expect(textGeneration.model).toBe(Models.summaryModel);
      expect(embeddings.model).toEqual(Models.embeddingModel);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "test-key" })))),
  );
});
