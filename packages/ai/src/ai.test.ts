import { describe, expect } from "bun:test";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { effect } from "@stargrep/testing";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Ai from "./ai.ts";
import * as AiFake from "./fake.ts";
import * as Summarize from "./prompts/summarize.ts";
import { toAiSchema } from "./schema-bridge.ts";

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

const withLanguageModel = (doGenerate: (options: CallOptions) => PromiseLike<GenerateResult>) => {
  const model = new MockLanguageModelV4({ doGenerate });
  const provider = Ai.AiProvider.of({
    languageModel: () => model,
    embeddingModel: (modelId) => AiFake.provider().embeddingModel(modelId),
  });
  return { model, layer: Ai.layer.pipe(Layer.provide(Layer.succeed(Ai.AiProvider, provider))) };
};

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

describe("schema bridge", () => {
  const aiSchema = toAiSchema(Summarize.RepoSummary);

  effect("hands the AI SDK a draft-07 JSON schema with the kind enum", () =>
    Effect.sync(() => {
      const jsonSchema = aiSchema["~standard"].jsonSchema.input({ target: "draft-07" });
      expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(jsonSchema).toMatchObject({
        type: "object",
        required: ["summary", "keywords", "kind"],
        properties: { kind: { enum: [...Summarize.RepoKind.literals] } },
      });
    }),
  );

  effect("validates with the Effect schema", () =>
    Effect.promise(async () => {
      expect(await aiSchema["~standard"].validate(validSummary)).toEqual({ value: validSummary });
      const invalid = await aiSchema["~standard"].validate({ ...validSummary, kind: "spaceship" });
      expect(invalid).toHaveProperty("issues");
    }),
  );
});

describe("generate", () => {
  effect("decodes the model's JSON into the summary schema", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)));
    return Summarize.summarize("test/model", repo).pipe(
      Effect.tap((summary) => Effect.sync(() => expect(summary).toEqual(validSummary))),
      Effect.provide(layer),
    );
  });

  effect("fails with AiOutputInvalid when the model returns text that is not JSON", () => {
    const { layer } = withLanguageModel(async () => textResult("Sure! Here is the summary you asked for."));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize("test/model", repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(error.message).toBe(
        "Model 'test/model' returned output that does not match the expected shape in 'generate'",
      );
    }).pipe(Effect.provide(layer));
  });

  effect("fails with AiOutputInvalid when the JSON does not match the schema", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify({ ...validSummary, kind: "spaceship" })));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize("test/model", repo));
      expect(error._tag).toBe("AiOutputInvalid");
    }).pipe(Effect.provide(layer));
  });

  effect("fails with AiTimeout and aborts the request once the clock passes the timeout", () => {
    let aborted = false;
    const { layer } = withLanguageModel(
      (options) =>
        new Promise((_, reject) =>
          options.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(options.abortSignal?.reason);
          }),
        ),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(Summarize.summarize("test/model", repo)));
      yield* TestClock.adjust("59 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(Ai.AiTimeout);
      expect(error.message).toBe("Model 'test/model' did not answer 'generate' within 60000 ms");
      expect(aborted).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  effect("fails with AiModelNotFound naming the model the gateway does not know", () => {
    const { layer } = withLanguageModel(async () => {
      throw new GatewayModelNotFoundError({ message: "Model not found", modelId: "acme/nope" });
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize("acme/nope", repo));
      expect(error._tag).toBe("AiModelNotFound");
      expect(error.message).toBe("Model 'acme/nope' is not available through the AI Gateway");
    }).pipe(Effect.provide(layer));
  });

  effect("fails with AiRequestFailed on any other provider error", () => {
    const { layer } = withLanguageModel(async () => {
      throw new Error("socket hang up");
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize("test/model", repo));
      expect(error._tag).toBe("AiRequestFailed");
    }).pipe(Effect.provide(layer));
  });

  effect("trims a long README before the call", () => {
    const { model, layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)));
    const longRepo = { ...repo, readme: "x".repeat(300_000) };
    return Summarize.summarize("test/model", longRepo).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sent = (model.doGenerateCalls[0]?.prompt ?? [])
            .flatMap((message) => (message.role === "user" ? message.content : []))
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
          expect(sent.length).toBeLessThan(Summarize.readmeLimit + 5_000);
          expect(sent).toContain("[README truncated]");
        }),
      ),
      Effect.provide(layer),
    );
  });

  effect("counts input and output tokens per model", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)));
    const tokens = (direction: string) =>
      Metric.value(Metric.withAttributes(Ai.tokensUsed, { model: "metered/model", direction }));
    return Effect.gen(function* () {
      const before = yield* tokens("output");
      yield* Summarize.summarize("metered/model", repo);
      expect((yield* tokens("output")).count - before.count).toBe(20);
    }).pipe(Effect.provide(layer));
  });
});

describe("embed", () => {
  const embeddingModel = { id: "test/embed", dimensions: 64 };

  effect("returns one vector of the configured size per value", () =>
    Effect.gen(function* () {
      const ai = yield* Ai.Ai;
      const values = Array.from({ length: 100 }, (_, index) => `text number ${index}`);
      const vectors = yield* ai.embed({ model: embeddingModel, values });
      expect(vectors).toHaveLength(100);
      expect(vectors.every((vector) => vector.length === 64)).toBe(true);
    }).pipe(Effect.provide(AiFake.layer())),
  );

  effect("fails with AiOutputInvalid when the model ignores the requested size", () => {
    const provider = Ai.AiProvider.of({
      languageModel: (modelId) => AiFake.provider().languageModel(modelId),
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2]), warnings: [] }),
        }),
    });
    return Effect.gen(function* () {
      const ai = yield* Ai.Ai;
      const error = yield* Effect.flip(ai.embed({ model: embeddingModel, values: ["one"] }));
      expect(error._tag).toBe("AiOutputInvalid");
    }).pipe(Effect.provide(Ai.layer.pipe(Layer.provide(Layer.succeed(Ai.AiProvider, provider)))));
  });
});

describe("fake layer", () => {
  effect("summarizes any repo into a valid RepoSummary", () =>
    Effect.gen(function* () {
      const summary = yield* Summarize.summarize("any/model", repo);
      expect(Schema.is(Summarize.RepoSummary)(summary)).toBe(true);
      expect(summary.summary).toContain("terminal user interfaces");
    }).pipe(Effect.provide(AiFake.layer())),
  );

  effect("embeds related texts closer than unrelated ones", () =>
    Effect.gen(function* () {
      const ai = yield* Ai.Ai;
      const [query, related, unrelated] = yield* ai.embed({
        model: { id: "fake/embed", dimensions: 256 },
        values: ["terminal dashboard library", "library for terminal dashboards and charts", "photo editing app"],
      });
      const dot = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
        left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
      expect(dot(query ?? [], related ?? [])).toBeGreaterThan(dot(query ?? [], unrelated ?? []));
    }).pipe(Effect.provide(AiFake.layer())),
  );
});
