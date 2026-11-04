import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import * as Summarize from "@stargrep/ai/summarize";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import type * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Corpus from "./corpus.ts";
import { embeddingLatencyBudgetMillis, type Row, rankEmbeddings, rankSummaries } from "./rank.ts";

const embeddingCandidates: ReadonlyArray<Models.EmbeddingModel> = [
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "google/gemini-embedding-001",
  "voyage/voyage-4-lite",
  "voyage/voyage-4",
  "cohere/embed-v5.0-fast",
  "alibaba/qwen3-embedding-8b",
].map((id) => ({ id, dimensions: 1024 }));

const summaryCandidates = ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna", "google/gemini-3.1-flash-lite"];

const topK = 10;
const summaryConcurrency = 8;

const retryTransient = <A, R>(effect: Effect.Effect<A, AiError, R>) =>
  Effect.retry(effect, {
    times: 3,
    schedule: Schedule.exponential("2 seconds"),
    while: (error) => error._tag === "AiUnavailable" || error._tag === "AiRequestFailed" || error._tag === "AiTimeout",
  });

const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      pricing: Schema.optional(
        Schema.Struct({ input: Schema.optional(Schema.String), output: Schema.optional(Schema.String) }),
      ),
    }),
  ),
});

type Pricing = Map<string, { input: number; output: number }>;

const loadPricing = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const catalog = yield* client
    .get("https://ai-gateway.vercel.sh/v1/models")
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Catalog)));
  const pricing: Pricing = new Map(
    catalog.data.map((model) => [
      model.id,
      { input: Number(model.pricing?.input ?? Number.NaN), output: Number(model.pricing?.output ?? 0) },
    ]),
  );
  return pricing;
}).pipe(
  Effect.catch(() => Console.log("Gateway catalog unavailable, cost shows n/a").pipe(Effect.as<Pricing>(new Map()))),
);

const tokens = (model: string, direction: "input" | "output") =>
  Metric.value(Metric.withAttributes(TextGeneration.tokensUsed, { model, direction })).pipe(
    Effect.map((state) => state.count),
  );

const withCost = Effect.fn("Bakeoff.withCost")(function* <A, E, R>(
  pricing: Pricing,
  model: string,
  run: Effect.Effect<A, E, R>,
) {
  const inputBefore = yield* tokens(model, "input");
  const outputBefore = yield* tokens(model, "output");
  const result = yield* run;
  const price = pricing.get(model);
  const inputTokens = (yield* tokens(model, "input")) - inputBefore;
  const outputTokens = (yield* tokens(model, "output")) - outputBefore;
  const cost = price === undefined ? Number.NaN : inputTokens * price.input + outputTokens * price.output;
  return { result, cost };
});

const cosine = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  left.forEach((value, index) => {
    const other = right[index] ?? 0;
    dot += value * other;
    leftNorm += value * value;
    rightNorm += other * other;
  });
  return dot / (Math.sqrt(leftNorm * rightNorm) || 1);
};

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const recallAt = (ranked: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  expected.filter((repo) => ranked.slice(0, topK).includes(repo)).length / expected.length;

interface Providers {
  readonly text: (model: string) => Layer.Layer<TextGeneration.TextGeneration, Config.ConfigError>;
  readonly embeddings: (model: Models.EmbeddingModel) => Layer.Layer<Embeddings.Embeddings, Config.ConfigError>;
}

const summarizeCorpus = Effect.fn("Bakeoff.summarizeCorpus")(function* (
  model: string,
  corpus: ReadonlyArray<Summarize.RepoFacts>,
) {
  const results = yield* Effect.forEach(
    corpus,
    (repo) =>
      Summarize.summarize(repo).pipe(
        retryTransient,
        Effect.timed,
        Effect.map(([duration, summary]) => ({ millis: Duration.toMillis(duration), summary })),
        Effect.catch((error) =>
          Console.log(`  ${model} failed on ${repo.fullName}: ${error.message}`).pipe(Effect.as(undefined)),
        ),
      ),
    { concurrency: summaryConcurrency },
  );
  return {
    texts: corpus.map((repo, index) => {
      const summary = results[index]?.summary ?? { summary: "", keywords: [], kind: "other" as const };
      return Summarize.embeddingText(repo, summary);
    }),
    millis: results.flatMap((result) => (result === undefined ? [] : [result.millis])),
    failures: results.filter((result) => result === undefined).length,
  };
});

const scoreRetrieval = Effect.fn("Bakeoff.scoreRetrieval")(function* (
  corpus: ReadonlyArray<Summarize.RepoFacts>,
  texts: ReadonlyArray<string>,
  queries: ReadonlyArray<Corpus.Query>,
) {
  const embeddings = yield* Embeddings.Embeddings;
  const documents = yield* embeddings.embed(texts).pipe(retryTransient);
  const millis: Array<number> = [];
  const recalls: Array<number> = [];
  for (const query of queries) {
    const [duration, [vector]] = yield* Effect.timed(embeddings.embed([query.query]).pipe(retryTransient));
    millis.push(Duration.toMillis(duration));
    const ranked = corpus
      .map((repo, index) => ({
        repo: repo.fullName,
        score: cosine(vector?.vector ?? [], documents[index]?.vector ?? []),
      }))
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.repo);
    recalls.push(recallAt(ranked, query.expected));
  }
  return { recall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length, medianMillis: median(millis) };
});

const formatRow = (row: Row) =>
  [
    row.stage.padEnd(10),
    row.model.padEnd(32),
    row.recall.toFixed(3).padStart(9),
    row.medianMillis.toFixed(0).padStart(10),
    (Number.isNaN(row.cost) ? "n/a" : `$${row.cost.toFixed(4)}`).padStart(10),
    String(row.failures).padStart(8),
  ].join(" ");

class NoEmbeddingScored extends Schema.TaggedError<NoEmbeddingScored>()("NoEmbeddingScored", {}) {}

const runBakeoff = Effect.fn("Bakeoff.run")(function* (limit: number | undefined, providers: Providers) {
  const allQueries = yield* Corpus.loadQueries;
  const queries = limit === undefined ? allQueries : allQueries.slice(0, limit);
  const distractors = limit === undefined ? yield* Corpus.loadDistractors : [];
  const repos = new Set([...Corpus.expectedRepos(queries), ...distractors]);
  const corpus = (yield* Corpus.loadCorpus).filter((repo) => repos.has(repo.fullName));
  const pricing = yield* loadPricing;
  yield* Console.log(`Bakeoff: ${queries.length} queries over ${corpus.length} repos, recall at ${topK}`);

  const baseline = Models.summaryModel;
  const summarizeWith = (model: string) => summarizeCorpus(model, corpus).pipe(Effect.provide(providers.text(model)));
  const scoreWith = (model: Models.EmbeddingModel, texts: ReadonlyArray<string>) =>
    scoreRetrieval(corpus, texts, queries).pipe(Effect.provide(providers.embeddings(model)));
  const baselineRun = yield* withCost(pricing, baseline, summarizeWith(baseline));

  const embeddingRows: Array<Row> = [];
  for (const model of embeddingCandidates) {
    const { result, cost } = yield* withCost(pricing, model.id, scoreWith(model, baselineRun.result.texts));
    embeddingRows.push({ stage: "embedding", model: model.id, ...result, cost, failures: 0 });
  }
  const { ranked: embeddingRanking, overBudget } = rankEmbeddings(embeddingRows);
  const embeddingWinner = embeddingCandidates.find((model) => model.id === embeddingRanking[0]?.model);
  if (embeddingWinner === undefined) return yield* new NoEmbeddingScored();

  const summaryRows: Array<Row> = [];
  for (const model of summaryCandidates) {
    const { result: run, cost } =
      model === baseline ? baselineRun : yield* withCost(pricing, model, summarizeWith(model));
    const score = yield* scoreWith(embeddingWinner, run.texts);
    summaryRows.push({
      stage: "summary",
      model,
      recall: score.recall,
      medianMillis: median(run.millis),
      cost,
      failures: run.failures,
    });
  }
  const summaryRanking = rankSummaries(summaryRows, queries.length);

  yield* Console.log(
    [
      "stage".padEnd(10),
      "model".padEnd(32),
      "recall@10".padStart(9),
      "median ms".padStart(10),
      "cost".padStart(10),
      "failures".padStart(8),
    ].join(" "),
  );
  for (const row of [...embeddingRows, ...summaryRows]) yield* Console.log(formatRow(row));
  yield* Console.log(`Embedding ranking: ${embeddingRanking.map((row) => row.model).join(" > ")}`);
  yield* Console.log(
    `Over the ${embeddingLatencyBudgetMillis} ms embedding latency budget: ${overBudget.map((row) => row.model).join(", ") || "none"}`,
  );
  yield* Console.log(`Summary ranking: ${summaryRanking.map((row) => row.model).join(" > ")}`);
  yield* Console.log(
    `Chosen: summary ${summaryRanking[0]?.model ?? baseline}, embedding ${embeddingWinner.id} at ${embeddingWinner.dimensions} dimensions`,
  );
  const totalCost = [baselineRun, ...embeddingRows, ...summaryRows.filter((row) => row.model !== baseline)].reduce(
    (sum, row) => sum + row.cost,
    0,
  );
  yield* Console.log(`Total model cost: $${totalCost.toFixed(4)}`);
});

const gatewayProviders: Providers = {
  text: (model) => Gateway.layerTextGeneration(model).pipe(Layer.provide(Gateway.layerProviderConfig)),
  embeddings: (model) => Gateway.layerEmbeddings(model).pipe(Layer.provide(Gateway.layerProviderConfig)),
};

const fakeProviders: Providers = {
  text: (model) => Fake.layerTextGeneration(SummarizeFake.respond, model),
  embeddings: Fake.layerEmbeddings,
};

const args = Bun.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex === -1 ? undefined : Number(args[limitIndex + 1]);

await Effect.runPromise(
  runBakeoff(limit, args.includes("--fake") ? fakeProviders : gatewayProviders).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
);
