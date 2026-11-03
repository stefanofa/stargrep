import { describe, expect } from "bun:test";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import * as it from "@stargrep/testing";
import { APICallError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Embeddings from "./embeddings.ts";
import * as Fake from "./fake.ts";
import * as Gateway from "./gateway.ts";
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

const withLanguageModel = (doGenerate: (options: CallOptions) => PromiseLike<GenerateResult>, model = "test/model") => {
  const languageModel = new MockLanguageModelV4({ doGenerate });
  const provider = Gateway.AiProvider.of({
    languageModel: () => languageModel,
    embeddingModel: (modelId) => Fake.provider().embeddingModel(modelId),
  });
  return {
    languageModel,
    layer: Gateway.layerTextGeneration(model).pipe(Layer.provide(Layer.succeed(Gateway.AiProvider, provider))),
  };
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

  it.effect("hands the AI SDK a draft-07 JSON schema with the kind enum", () =>
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

  it.effect("validates with the Effect schema", () =>
    Effect.promise(async () => {
      expect(await aiSchema["~standard"].validate(validSummary)).toEqual({ value: validSummary });
      const invalid = await aiSchema["~standard"].validate({ ...validSummary, kind: "spaceship" });
      expect(invalid).toHaveProperty("issues");
    }),
  );
});

describe("gateway text generation", () => {
  it.effect("decodes the model's JSON into the summary schema", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)));
    return Summarize.summarize(repo).pipe(
      Effect.tap((summary) => Effect.sync(() => expect(summary).toEqual(validSummary))),
      Effect.provide(layer),
    );
  });

  it.effect("fails with AiOutputInvalid when the model returns text that is not JSON", () => {
    const { layer } = withLanguageModel(async () => textResult("Sure! Here is the summary you asked for."));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(error.message).toBe(
        "Model 'test/model' returned output that does not match the expected shape in 'generate': structured output does not match the schema",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiOutputInvalid when the JSON does not match the schema", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify({ ...validSummary, kind: "spaceship" })));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(JSON.stringify(error)).not.toContain("spaceship");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiTimeout and aborts the request once the clock passes the timeout", () => {
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
      const fiber = yield* Effect.forkChild(Effect.flip(Summarize.summarize(repo)));
      yield* TestClock.adjust("59 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe("AiTimeout");
      expect(error.message).toBe("Model 'test/model' did not answer 'generate' within 60000 ms");
      expect(aborted).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiModelNotFound naming the model the gateway does not know", () => {
    const { layer } = withLanguageModel(async () => {
      throw new GatewayModelNotFoundError({ message: "Model not found", modelId: "acme/nope" });
    }, "acme/nope");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiModelNotFound");
      expect(error.message).toBe("Model 'acme/nope' is not available from this provider");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiRequestFailed that keeps the status and drops the request body", () => {
    const { layer } = withLanguageModel(async () => {
      throw new APICallError({
        message: "upstream failed",
        url: "https://ai-gateway.vercel.sh/v1",
        requestBodyValues: { prompt: "SECRET README TEXT" },
        statusCode: 502,
      });
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiRequestFailed");
      expect(error.message).toBe("Model 'test/model' request failed in 'generate': AI_APICallError with status 502");
      expect(JSON.stringify(error)).not.toContain("SECRET");
    }).pipe(Effect.provide(layer));
  });

  it.effect("trims a long README before the call", () => {
    const { languageModel, layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)));
    return Summarize.summarize({ ...repo, readme: "x".repeat(300_000) }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sent = (languageModel.doGenerateCalls[0]?.prompt ?? [])
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

  it.effect("counts input and output tokens per model", () => {
    const { layer } = withLanguageModel(async () => textResult(JSON.stringify(validSummary)), "metered/model");
    const tokens = (direction: string) =>
      Metric.value(Metric.withAttributes(Gateway.tokensUsed, { model: "metered/model", direction }));
    return Effect.gen(function* () {
      const before = yield* tokens("output");
      yield* Summarize.summarize(repo);
      expect((yield* tokens("output")).count - before.count).toBe(20);
    }).pipe(Effect.provide(layer));
  });
});

describe("gateway embeddings", () => {
  const model = { id: "test/embed", dimensions: 64 };

  it.effect("returns one vector of the configured size per value, tagged with the model", () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const values = Array.from({ length: 100 }, (_, index) => `text number ${index}`);
      const vectors = yield* embeddings.embed(values);
      expect(vectors).toHaveLength(100);
      expect(vectors.every((embedding) => embedding.vector.length === 64 && embedding.model === "test/embed")).toBe(
        true,
      );
    }).pipe(Effect.provide(Fake.layerEmbeddings(model))),
  );

  it.effect("fails with AiOutputInvalid when the model ignores the requested size", () => {
    const provider = Gateway.AiProvider.of({
      languageModel: (modelId) => Fake.provider().languageModel(modelId),
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2]), warnings: [] }),
        }),
    });
    return Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const error = yield* Effect.flip(embeddings.embed(["one"]));
      expect(error._tag).toBe("AiOutputInvalid");
    }).pipe(
      Effect.provide(Gateway.layerEmbeddings(model).pipe(Layer.provide(Layer.succeed(Gateway.AiProvider, provider)))),
    );
  });
});

describe("embedding model guard", () => {
  const database = { id: "alibaba/qwen3-embedding-8b", dimensions: 1024 };

  it.effect("accepts a vector from the database's model", () =>
    Effect.gen(function* () {
      const embedding = { model: database.id, vector: new Array(1024).fill(0) };
      expect(yield* Embeddings.requireModel(database)(embedding)).toBe(embedding);
    }),
  );

  it.effect("refuses a fake vector even when its size matches", () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const [embedding] = yield* embeddings.embed(["terminal dashboards"]);
      const error = yield* Effect.flip(Embeddings.requireModel(database)(embedding ?? { model: "", vector: [] }));
      expect(error._tag).toBe("EmbeddingModelMismatch");
      expect(error.message).toBe(
        "Embedding from 'fake/hash-embedding' with 1024 dimensions cannot be stored where the database uses 'alibaba/qwen3-embedding-8b'",
      );
    }).pipe(Effect.provide(Fake.layerEmbeddings())),
  );
});

describe("fake layers", () => {
  it.effect("summarize any repo into a valid RepoSummary", () =>
    Effect.gen(function* () {
      const summary = yield* Summarize.summarize(repo);
      expect(Schema.is(Summarize.RepoSummary)(summary)).toBe(true);
      expect(summary.summary).toContain("terminal user interfaces");
    }).pipe(Effect.provide(Fake.layerTextGeneration())),
  );

  it.effect("embed related texts closer than unrelated ones", () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const [query, related, unrelated] = yield* embeddings.embed([
        "terminal dashboard library",
        "library for terminal dashboards and charts",
        "photo editing app",
      ]);
      const dot = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
        left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
      expect(dot(query?.vector ?? [], related?.vector ?? [])).toBeGreaterThan(
        dot(query?.vector ?? [], unrelated?.vector ?? []),
      );
    }).pipe(Effect.provide(Fake.layerEmbeddings())),
  );
});
