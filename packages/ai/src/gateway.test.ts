import { describe, expect, spyOn } from "bun:test";
import { GatewayInternalServerError, GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import { APICallError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as Embeddings from "./embeddings.ts";
import * as Gateway from "./gateway.ts";
import * as Models from "./models.ts";
import * as Port from "./port.ts";
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

const noTextResult: GenerateResult = {
  ...textResult(""),
  content: [],
  finishReason: { unified: "length", raw: "max_tokens" },
};

const unused = () => {
  throw new Error("not used in this test");
};

const textLayer = (
  doGenerate: (options: CallOptions) => PromiseLike<GenerateResult>,
  model = "test/model",
  options: Partial<Gateway.TextOptions> = {},
) =>
  Gateway.layerTextGeneration(model, options).pipe(
    Layer.provide(
      Layer.succeed(
        Gateway.AiProvider,
        Gateway.AiProvider.of({
          languageModel: () => new MockLanguageModelV4({ doGenerate }),
          embeddingModel: unused,
          experimental_batch: unused,
        }),
      ),
    ),
  );

const settleSteps = 120;

// Each attempt settles a promise before its backoff sleep starts, and TestClock.adjust never yields to the
// event loop. So each step yields first, letting the fake's promises settle, then moves the clock.
const settle = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let step = 0; step < settleSteps && fiber.pollUnsafe() === undefined; step++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    if (fiber.pollUnsafe() === undefined) {
      return yield* Effect.die(`the retried call was still running after ${settleSteps} virtual seconds`);
    }
    return yield* Fiber.join(fiber);
  });

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

  it.effect("asks for no reasoning only when the layer is built with reasoning none", () => {
    const seen: Array<CallOptions["reasoning"]> = [];
    const answer = async (options: CallOptions) => {
      seen.push(options.reasoning);
      return textResult(JSON.stringify(validSummary));
    };
    return Effect.gen(function* () {
      yield* Summarize.summarize(repo).pipe(Effect.provide(textLayer(answer)));
      yield* Summarize.summarize(repo).pipe(Effect.provide(textLayer(answer, "test/model", { reasoning: "none" })));
      expect(seen).toEqual(["provider-default", "none"]);
    });
  });

  it.effect("fails with AiOutputInvalid when the model returns text that is not JSON", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiOutputInvalid");
      expect(error.message).toBe(
        "Model 'test/model' returned output that does not match the expected shape in 'generate': the model did not return a JSON object",
      );
    }).pipe(Effect.provide(textLayer(async () => textResult("Sure! Here is the summary you asked for.")))),
  );

  it.effect("fails with AiOutputInvalid naming the finish reason when the model returns no text", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error).toMatchObject({
        _tag: "AiOutputInvalid",
        detail: "the model returned no output, finish reason length",
      });
    }).pipe(Effect.provide(textLayer(async () => noTextResult))),
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
      expect(error.message).toBe("Model 'test/model' request failed in 'generate': AI_APICallError with status 400");
      expect(JSON.stringify(error)).not.toContain("SECRET");
    }).pipe(
      Effect.provide(
        textLayer(async () => {
          throw new APICallError({
            message: "bad request",
            url: "https://ai-gateway.vercel.sh/v1",
            requestBodyValues: { prompt: "SECRET README TEXT" },
            statusCode: 400,
          });
        }),
      ),
    ),
  );

  it.effect("lets the SDK retry an error it marks as retryable three times, then fails with AiUnavailable", () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const upstream = yield* Effect.flip(Summarize.summarize(repo));
      expect(attempts).toBe(4);
      expect(upstream.message).toBe(
        "Model 'test/model' is unavailable for 'generate' and may answer a retry: AI_APICallError with status 502 after 4 attempts",
      );
      expect(JSON.stringify(upstream)).not.toContain("SECRET");
    }).pipe(
      Effect.provide(
        textLayer(async () => {
          attempts++;
          throw new APICallError({
            message: "upstream failed",
            url: "https://ai-gateway.vercel.sh/v1",
            requestBodyValues: { prompt: "SECRET README TEXT" },
            statusCode: 502,
            responseHeaders: { "retry-after-ms": "0" },
          });
        }),
      ),
    );
  });

  it.effect("waits as long as the provider's retry-after asks before it tries again", () => {
    const tried: Array<number> = [];
    return Effect.gen(function* () {
      expect(yield* Summarize.summarize(repo)).toEqual(validSummary);
      const [first = 0, second = 0] = tried;
      expect(second - first).toBeGreaterThanOrEqual(40);
    }).pipe(
      Effect.provide(
        textLayer(async () => {
          tried.push(performance.now());
          if (tried.length > 1) return textResult(JSON.stringify(validSummary));
          throw new APICallError({
            message: "rate limited",
            url: "https://ai-gateway.vercel.sh/v1",
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { "retry-after-ms": "40" },
          });
        }),
      ),
    );
  });

  it.effect("tries once and gives up on a retryable error when the layer has no retries", () => {
    let attempts = 0;
    const layer = textLayer(
      async () => {
        attempts++;
        throw new APICallError({
          message: "upstream failed",
          url: "https://ai-gateway.vercel.sh/v1",
          requestBodyValues: {},
          statusCode: 502,
        });
      },
      "test/model",
      { maxRetries: 0 },
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect([error._tag, attempts]).toEqual(["AiUnavailable", 1]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiTimeout at the timeout the layer sets", () => {
    const layer = textLayer(
      (options) =>
        new Promise((_, reject) =>
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason)),
        ),
      "test/model",
      { timeout: Duration.seconds(4), maxRetries: 0 },
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(Summarize.summarize(repo)));
      yield* TestClock.adjust("3999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "AiTimeout", timeoutMillis: 4000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with AiUnavailable on the gateway's internal server error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(repo));
      expect(error._tag).toBe("AiUnavailable");
      expect(error.message).toContain("GatewayInternalServerError with status 500");
    }).pipe(
      Effect.provide(
        textLayer(
          async () => {
            throw new GatewayInternalServerError({ message: "Internal server error" });
          },
          "test/model",
          { maxRetries: 0 },
        ),
      ),
    ),
  );

  it.effect("counts the gateway's reported tokens per model", () =>
    Effect.gen(function* () {
      const before = yield* Port.tokensSpent("metered/model");
      yield* Summarize.summarize(repo);
      expect((yield* Port.tokensSpent("metered/model")).output - before.output).toBe(20);
    }).pipe(Effect.provide(textLayer(async () => textResult(JSON.stringify(validSummary)), "metered/model"))),
  );
});

type BatchApi = ReturnType<Gateway.AiProvider["Service"]["experimental_batch"]>;
type StartOptions = Parameters<BatchApi["doStartBatch"]>[0];
type BatchItem = Awaited<ReturnType<BatchApi["doGetBatchResults"]>> extends ReadableStream<infer Item> ? Item : never;

const succeeded = (id: string, text: string): BatchItem => ({
  type: "text",
  id,
  status: "succeeded",
  result: textResult(text),
});

type BatchCall = "start" | "status" | "results";

const fakeBatch = (options: {
  readonly items: ReadonlyArray<BatchItem>;
  readonly fails?: boolean;
  readonly throwOnce?: ReadonlyArray<BatchCall>;
}) => {
  const starts: Array<StartOptions> = [];
  const direct = { calls: 0 };
  const calls: Record<BatchCall, number> = { start: 0, status: 0, results: 0 };
  const firstStart = Promise.withResolvers<void>();
  const attempt = (call: BatchCall) => {
    calls[call]++;
    if (calls[call] === 1 && options.throwOnce?.includes(call)) {
      throw new GatewayInternalServerError({ message: "Internal server error" });
    }
  };
  const languageModel = () =>
    new MockLanguageModelV4({
      doGenerate: async () => {
        direct.calls++;
        return textResult(JSON.stringify(validSummary));
      },
    });
  const api: BatchApi = {
    specificationVersion: "v4",
    provider: "gateway.batch",
    supportedUrls: {},
    doStartBatch: async (start) => {
      firstStart.resolve();
      attempt("start");
      starts.push(start);
      return { batchId: `job_${starts.length}`, status: "pending", warnings: [] };
    },
    doGetBatchStatus: async () => {
      attempt("status");
      return options.fails
        ? { status: "failed", error: { message: "rejected", code: "invalid_batch" } }
        : { status: "completed" };
    },
    doGetBatchResults: async () => {
      attempt("results");
      return new ReadableStream<BatchItem>({
        start: (controller) => {
          for (const item of options.items) controller.enqueue(item);
          controller.close();
        },
      });
    },
  };
  const layer = Gateway.layerTextGeneration("test/model").pipe(
    Layer.provide(
      Layer.succeed(
        Gateway.AiProvider,
        Gateway.AiProvider.of({ languageModel, embeddingModel: unused, experimental_batch: () => api }),
      ),
    ),
  );
  return { starts, direct, calls, layer, firstStart: firstStart.promise };
};

const batchRepos = [repo, { ...repo, fullName: "junegunn/fzf" }, { ...repo, fullName: "sharkdp/bat" }];

describe("gateway batch", () => {
  it.effect("submits one job with the JSON schema and answers failed or invalid items with a direct call", () => {
    const fake = fakeBatch({
      items: [
        succeeded("2", "Sure! Here is the summary."),
        succeeded("0", JSON.stringify(validSummary)),
        { type: "text", id: "1", status: "failed", error: { message: "upstream", code: "server_error" } },
      ],
    });
    return Effect.gen(function* () {
      const results = yield* Summarize.summarizeBatch(batchRepos);
      expect(fake.starts).toHaveLength(1);
      const request = fake.starts[0]?.requests[0];
      expect(request?.modelId).toBe("test/model");
      expect(request?.type === "text" && request.options.responseFormat?.type).toBe("json");
      expect(request?.id).toBe("0");
      expect(results).toEqual([
        Result.succeed(validSummary),
        Result.succeed(validSummary),
        Result.succeed(validSummary),
      ]);
      expect(fake.direct.calls).toBe(2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("puts token counts on each direct call's span, not on the batch span, and counts every item", () => {
    const { spans, tracer } = collectSpans();
    const fake = fakeBatch({
      items: [
        succeeded("0", JSON.stringify(validSummary)),
        succeeded("1", JSON.stringify(validSummary)),
        { type: "text", id: "2", status: "failed", error: { message: "upstream", code: "server_error" } },
      ],
    });
    return Effect.gen(function* () {
      const before = yield* Port.tokensSpent("test/model");
      const results = yield* Summarize.summarizeBatch(batchRepos);
      const after = yield* Port.tokensSpent("test/model");
      expect(results.map(Result.isSuccess)).toEqual([true, true, true]);
      const attributes = (name: string) =>
        spans.filter((span) => span.name === name).map((span) => Object.fromEntries(span.attributes));
      expect(attributes("TextGeneration.generateBatch")).toEqual([
        expect.not.objectContaining({ "gen_ai.usage.input_tokens": expect.anything() }),
      ]);
      expect(attributes("TextGeneration.generate")).toEqual([
        expect.objectContaining({ "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 }),
      ]);
      expect({ input: after.input - before.input, output: after.output - before.output }).toEqual({
        input: 300,
        output: 60,
      });
    }).pipe(Effect.provide(fake.layer), Effect.withTracer(tracer));
  });

  it.effect("answers an item the batch left out with a direct call, in prompt order", () => {
    const other = { ...validSummary, summary: "A command-line fuzzy finder." };
    const fake = fakeBatch({ items: [succeeded("1", JSON.stringify(other))] });
    return Effect.gen(function* () {
      const results = yield* Summarize.summarizeBatch([repo, repo]);
      expect(results).toEqual([Result.succeed(validSummary), Result.succeed(other)]);
      expect(fake.direct.calls).toBe(1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("sends the same idempotency key for the same batch and a new one when a prompt changes", () => {
    const fake = fakeBatch({ items: [succeeded("0", JSON.stringify(validSummary))] });
    const keyOf = (start: StartOptions | undefined) =>
      (start?.providerOptions?.gateway as { readonly idempotencyKey?: string } | undefined)?.idempotencyKey;
    return Effect.gen(function* () {
      yield* Summarize.summarizeBatch([repo, repo]);
      yield* Summarize.summarizeBatch([repo, repo]);
      yield* Summarize.summarizeBatch([repo, { ...repo, readme: "a new README" }]);
      const [first, again, changed] = fake.starts.map(keyOf);
      expect(first).toMatch(/^stargrep-batch-[0-9a-f]{64}$/);
      expect(again).toBe(first);
      expect(changed).not.toBe(first);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("answers a single prompt directly, without starting a batch job", () => {
    const fake = fakeBatch({ items: [] });
    return Effect.gen(function* () {
      expect(yield* Summarize.summarizeBatch([repo])).toEqual([Result.succeed(validSummary)]);
      expect(fake.starts).toHaveLength(0);
      expect(fake.direct.calls).toBe(1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("answers every prompt directly when the gateway fails the whole batch", () => {
    const fake = fakeBatch({ items: [], fails: true });
    return Effect.gen(function* () {
      const results = yield* Summarize.summarizeBatch(batchRepos);
      expect(results).toEqual(batchRepos.map(() => Result.succeed(validSummary)));
      expect(fake.direct.calls).toBe(3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("retries a failed start, status check, and result read without starting a second job", () => {
    const fake = fakeBatch({
      items: [succeeded("0", JSON.stringify(validSummary)), succeeded("1", JSON.stringify(validSummary))],
      throwOnce: ["start", "status", "results"],
    });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Summarize.summarizeBatch([repo, repo]));
      // The idempotency key's SHA-256 runs on real time, so the clock steps start once the job is first sent.
      yield* Effect.promise(() => fake.firstStart);
      expect(yield* settle(fiber)).toEqual([Result.succeed(validSummary), Result.succeed(validSummary)]);
      expect(fake.calls).toEqual({ start: 2, status: 2, results: 2 });
      expect(fake.starts).toHaveLength(1);
      expect(fake.direct.calls).toBe(0);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("gateway embeddings", () => {
  it.effect("retries only the provider call that failed when the SDK splits the texts", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const provider = Gateway.AiProvider.of({
      languageModel: unused,
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          maxEmbeddingsPerCall: 2,
          supportsParallelCalls: false,
          doEmbed: async ({ values }) => {
            calls.push(values);
            if (values.includes("three") && calls.length === 2) {
              throw new APICallError({
                message: "overloaded",
                url: "https://ai-gateway.vercel.sh/v1",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "0" },
              });
            }
            return { embeddings: values.map(() => Array.from({ length: 64 }, () => 0.1)), warnings: [] };
          },
        }),
      experimental_batch: unused,
    });
    return Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      expect(yield* embeddings.embed(["one", "two", "three", "four"])).toHaveLength(4);
      expect(calls).toEqual([
        ["one", "two"],
        ["three", "four"],
        ["three", "four"],
      ]);
    }).pipe(
      Effect.provide(
        Gateway.layerEmbeddings({ ...Models.embeddingModel, id: "test/embed", dimensions: 64 }).pipe(
          Layer.provide(Layer.succeed(Gateway.AiProvider, provider)),
        ),
      ),
    );
  });

  it.effect("fails with AiOutputInvalid when the model ignores the requested size", () => {
    const provider = Gateway.AiProvider.of({
      languageModel: unused,
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2]), warnings: [] }),
        }),
      experimental_batch: unused,
    });
    return Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      expect((yield* Effect.flip(embeddings.embed(["one"])))._tag).toBe("AiOutputInvalid");
    }).pipe(
      Effect.provide(
        Gateway.layerEmbeddings({ ...Models.embeddingModel, id: "test/embed", dimensions: 64 }).pipe(
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

describe("gateway privacy", () => {
  const promptCanary = "PRIVATE_GATEWAY_PROMPT_CANARY";
  const outputCanary = "PRIVATE_GATEWAY_OUTPUT_CANARY";
  const warning = { type: "other" as const, message: `provider warning with ${promptCanary} ${outputCanary}` };

  it.effect("keeps provider warnings, prompts, and output out of stdout, stderr, and logs", () => {
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    const printed: Array<string> = [];
    const record = (...args: ReadonlyArray<unknown>) => {
      printed.push(args.map(String).join(" "));
      return true;
    };
    const spies = [
      spyOn(console, "log").mockImplementation(record),
      spyOn(console, "info").mockImplementation(record),
      spyOn(console, "warn").mockImplementation(record),
      spyOn(console, "error").mockImplementation(record),
      spyOn(process, "emitWarning").mockImplementation(record),
      spyOn(process.stdout, "write").mockImplementation(record),
      spyOn(process.stderr, "write").mockImplementation(record),
    ];
    const provider = Gateway.AiProvider.of({
      languageModel: () =>
        new MockLanguageModelV4({
          doGenerate: async () => ({
            ...textResult(JSON.stringify({ ...validSummary, summary: outputCanary })),
            warnings: [warning],
          }),
        }),
      embeddingModel: () =>
        new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0]), warnings: [warning] }),
        }),
      experimental_batch: unused,
    });
    const layer = Layer.merge(
      Gateway.layerTextGeneration("private/model"),
      Gateway.layerEmbeddings({ ...Models.embeddingModel, id: "private/embed", dimensions: 3 }),
    ).pipe(Layer.provide(Layer.succeed(Gateway.AiProvider, provider)));
    const logs: Array<unknown> = [];
    const logger = Logger.make((options) => {
      logs.push(options.message);
    });
    return Effect.gen(function* () {
      const summary = yield* Summarize.summarize({ ...repo, readme: promptCanary });
      const embeddings = yield* Embeddings.Embeddings;
      yield* embeddings.embed([promptCanary]);
      expect(summary.summary).toBe(outputCanary);
      const seen = JSON.stringify({ printed, logs });
      expect(seen).not.toContain(promptCanary);
      expect(seen).not.toContain(outputCanary);
    }).pipe(
      Effect.provide(Layer.merge(layer, Logger.layer([logger]))),
      Effect.ensuring(
        Effect.sync(() => {
          for (const spy of spies) spy.mockRestore();
        }),
      ),
    );
  });

  const keyCanary = "sk-PRIVATE-GATEWAY-KEY-CANARY";
  const rejected = JSON.stringify({ summary: keyCanary, keywords: "not a list", kind: "cli" });
  const gatewayUsage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

  const gatewayFetch = (direct: string) => {
    const authorized: Array<boolean> = [];
    const answer = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      authorized.push(request.headers.get("authorization")?.includes(keyCanary) ?? false);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/batch/start")) {
        return Response.json({ batchId: "job_private", status: "completed", warnings: [] });
      }
      if (path.endsWith("/batch/results")) {
        const content = [{ type: "text", text: rejected }];
        const item = { type: "text", id: "0", status: "succeeded", result: { content, usage: gatewayUsage } };
        return new Response(`${JSON.stringify(item)}\n`, { headers: { "content-type": "application/x-ndjson" } });
      }
      const content = [{ type: "text", text: direct }];
      return Response.json({ content, finishReason: { unified: "stop" }, usage: gatewayUsage, warnings: [] });
    };
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(answer, { preconnect: globalThis.fetch.preconnect }),
    );
    return { authorized, spy };
  };

  const throughGateway = <E>(
    direct: string,
    check: (seen: {
      readonly authorized: ReadonlyArray<boolean>;
      readonly spans: ReadonlyArray<Tracer.NativeSpan>;
    }) => Effect.Effect<void, E, TextGeneration.TextGeneration>,
  ) => {
    const fetch = gatewayFetch(direct);
    const collected = collectSpans();
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(Logger.formatJson.log(options));
    });
    const layer = Gateway.layerTextGeneration("anthropic/claude-haiku-5.5").pipe(
      Layer.provide(Gateway.layerProvider({ apiKey: Redacted.make(keyCanary) })),
    );
    return check({ authorized: fetch.authorized, spans: collected.spans }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(collected.spans.map((span) => span.name)).toContain("Gateway.runBatch");
          expect(collected.text()).not.toContain(keyCanary);
          expect(logs.join("\n")).not.toContain(keyCanary);
        }),
      ),
      Effect.withTracer(collected.tracer),
      Effect.provide(Layer.merge(layer, Logger.layer([logger]))),
      Effect.ensuring(Effect.sync(() => fetch.spy.mockRestore())),
    );
  };

  it.effect("keeps rejected batch output out of every span when the direct fallback recovers", () =>
    throughGateway(JSON.stringify(validSummary), ({ authorized }) =>
      Effect.gen(function* () {
        expect(yield* Summarize.summarizeBatch([{ ...repo, readme: keyCanary }, repo])).toEqual([
          Result.succeed(validSummary),
          Result.succeed(validSummary),
        ]);
        expect(authorized).toEqual([true, true, true, true]);
      }),
    ),
  );

  it.effect("keeps rejected output out of every span when the direct fallback fails too", () =>
    throughGateway(rejected, ({ spans }) =>
      Effect.gen(function* () {
        const answers = yield* Summarize.summarizeBatch([{ ...repo, readme: keyCanary }, repo]);
        expect(answers.map((answer) => Result.isFailure(answer) && answer.failure._tag)).toEqual([
          "AiOutputInvalid",
          "AiOutputInvalid",
        ]);
        expect((yield* Effect.flip(Summarize.summarize({ ...repo, readme: keyCanary })))._tag).toBe("AiOutputInvalid");
        const failed = spans.filter((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit));
        expect(failed.map((span) => span.name)).toEqual([
          "TextGeneration.generate",
          "TextGeneration.generate",
          "TextGeneration.generate",
        ]);
      }),
    ),
  );
});

describe("gateway without the batch API", () => {
  it.effect("answers a batch of prompts with one direct call each and never starts a batch job", () => {
    const { spans, tracer } = collectSpans();
    let calls = 0;
    const layer = textLayer(
      () => {
        calls++;
        return Promise.resolve(textResult(JSON.stringify(validSummary)));
      },
      Models.summaryModel,
      { batch: false },
    );
    return Effect.gen(function* () {
      const results = yield* Summarize.summarizeBatch([repo, { ...repo, fullName: "other/repo" }, repo]);
      expect(results.map(Result.isSuccess)).toEqual([true, true, true]);
      expect(calls).toBe(3);
      const generated = spans.filter((span) => span.name === "TextGeneration.generate");
      expect(generated.map((span) => Object.fromEntries(span.attributes))).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 }),
        ),
      );
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
  });

  it.effect("fails only the prompt whose call returns no output", () => {
    let calls = 0;
    const layer = textLayer(
      () => Promise.resolve(++calls === 2 ? noTextResult : textResult(JSON.stringify(validSummary))),
      Models.summaryModel,
      { batch: false },
    );
    return Effect.gen(function* () {
      const results = yield* Summarize.summarizeBatch([repo, { ...repo, fullName: "other/repo" }, repo]);
      expect(results.map((result) => (Result.isSuccess(result) ? "summary" : result.failure._tag))).toEqual([
        "summary",
        "AiOutputInvalid",
        "summary",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("gateway with no key", () => {
  it.effect("fails every summary and embedding with AiKeyMissing and sends nothing", () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const summary = yield* Effect.flip(Summarize.summarize(repo));
      const embedded = yield* Effect.flip(embeddings.embed(["a repo"]));
      expect([summary, embedded]).toMatchObject([
        { _tag: "AiKeyMissing", operation: "generate", model: Models.summaryModel },
        { _tag: "AiKeyMissing", operation: "embed", model: Models.embeddingModel.id },
      ]);
    }).pipe(Effect.provide(Gateway.layerKeyMissing)),
  );
});
