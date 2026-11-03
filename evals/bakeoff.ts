import * as Ai from "@stargrep/ai";
import * as AiFake from "@stargrep/ai/fake";
import * as Models from "@stargrep/ai/models";
import * as Summarize from "@stargrep/ai/summarize";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

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
const graphqlBatchSize = 25;
const readmeNames = ["README.md", "readme.md", "Readme.md", "README.rst", "README.markdown", "README"];

const queriesPath = new URL("./queries.json", import.meta.url);
const corpusPath = new URL("./.cache/corpus.json", import.meta.url);
const modelsPath = new URL("../packages/ai/src/models.ts", import.meta.url);

const Query = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  query: Schema.String,
  expected: Schema.Array(Schema.String),
});
type Query = typeof Query.Type;

const RepoFacts = Schema.Struct({
  fullName: Schema.String,
  description: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  language: Schema.NullOr(Schema.String),
  readme: Schema.NullOr(Schema.String),
});

const decodeQueries = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Query)));
const decodeCorpus = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RepoFacts)));
const encodeCorpus = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(RepoFacts)));

const Blob = Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.NullOr(Schema.String)) }));

const RepoNode = Schema.Struct({
  nameWithOwner: Schema.String,
  description: Schema.NullOr(Schema.String),
  repositoryTopics: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })),
  }),
  primaryLanguage: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  ...Object.fromEntries(readmeNames.map((_, index) => [`readme${index}`, Schema.optional(Blob)])),
});

const GraphqlResponse = Schema.Struct({ data: Schema.Record(Schema.String, Schema.NullOr(RepoNode)) });

const CatalogModel = Schema.Struct({
  id: Schema.String,
  pricing: Schema.optional(
    Schema.Struct({ input: Schema.optional(Schema.String), output: Schema.optional(Schema.String) }),
  ),
});
const Catalog = Schema.Struct({ data: Schema.Array(CatalogModel) });

class BakeoffFailed extends Schema.TaggedError<BakeoffFailed>()("BakeoffFailed", { reason: Schema.String }) {
  override get message(): string {
    return this.reason;
  }
}

const readText = (url: URL) =>
  Effect.tryPromise({
    try: () => Bun.file(url).text(),
    catch: () => new BakeoffFailed({ reason: `cannot read ${url.pathname}` }),
  });

const writeText = (url: URL, text: string) =>
  Effect.tryPromise({
    try: () => Bun.write(url, text),
    catch: () => new BakeoffFailed({ reason: `cannot write ${url.pathname}` }),
  });

const expectedRepos = (queries: ReadonlyArray<Query>) =>
  [...new Set(queries.flatMap((query) => query.expected))].sort();

const fetchCorpus = Effect.fn("Bakeoff.fetchCorpus")(function* (repos: ReadonlyArray<string>) {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const corpus: Array<typeof RepoFacts.Type> = [];
  const problems: Array<string> = [];
  for (let start = 0; start < repos.length; start += graphqlBatchSize) {
    const batch = repos.slice(start, start + graphqlBatchSize);
    const fields = batch.map((fullName, index) => {
      const [owner, name] = fullName.split("/");
      const readmes = readmeNames
        .map((file, readme) => `readme${readme}: object(expression: "HEAD:${file}") { ... on Blob { text } }`)
        .join(" ");
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner description repositoryTopics(first: 20) { nodes { topic { name } } } primaryLanguage { name } ${readmes} }`;
    });
    const response = yield* HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.setHeader("user-agent", "stargrep-evals"),
      HttpClientRequest.bodyJsonUnsafe({ query: `{ ${fields.join("\n")} }` }),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphqlResponse)),
    );
    for (const [index, fullName] of batch.entries()) {
      const node = response.data[`r${index}`];
      if (node === null || node === undefined) {
        problems.push(`missing ${fullName}`);
        continue;
      }
      if (node.nameWithOwner !== fullName) problems.push(`renamed ${fullName} -> ${node.nameWithOwner}`);
      const readme = readmeNames
        .map((_, readmeIndex) => (node as Record<string, typeof Blob.Type | undefined>)[`readme${readmeIndex}`]?.text)
        .find((text) => typeof text === "string");
      corpus.push({
        fullName,
        description: node.description,
        topics: node.repositoryTopics.nodes.map((topicNode) => topicNode.topic.name),
        language: node.primaryLanguage?.name ?? null,
        readme: readme ?? null,
      });
    }
  }
  return { corpus, problems };
});

const loadPricing = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const catalog = yield* client
    .get("https://ai-gateway.vercel.sh/v1/models")
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Catalog)));
  return new Map(
    catalog.data.map((model) => [
      model.id,
      { input: Number(model.pricing?.input ?? Number.NaN), output: Number(model.pricing?.output ?? 0) },
    ]),
  );
}).pipe(
  Effect.catch(() =>
    Console.log("Gateway catalog unavailable, cost shows n/a").pipe(
      Effect.as(new Map<string, { input: number; output: number }>()),
    ),
  ),
);

const tokens = (model: string, direction: "input" | "output") =>
  Metric.value(Metric.withAttributes(Ai.tokensUsed, { model, direction })).pipe(Effect.map((state) => state.count));

const withCost = Effect.fn("Bakeoff.withCost")(function* <A, E, R>(
  pricing: Map<string, { input: number; output: number }>,
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

interface Row {
  readonly stage: "embedding" | "summary";
  readonly model: string;
  readonly recall: number;
  readonly medianMillis: number;
  readonly cost: number;
  readonly failures: number;
}

const summarizeCorpus = Effect.fn("Bakeoff.summarizeCorpus")(function* (
  model: string,
  corpus: ReadonlyArray<typeof RepoFacts.Type>,
) {
  const results = yield* Effect.forEach(
    corpus,
    (repo) =>
      Summarize.summarize(model, repo).pipe(
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
  model: Models.EmbeddingModel,
  corpus: ReadonlyArray<typeof RepoFacts.Type>,
  texts: ReadonlyArray<string>,
  queries: ReadonlyArray<Query>,
) {
  const ai = yield* Ai.Ai;
  const documents = yield* ai.embed({ model, values: texts });
  const millis: Array<number> = [];
  const recalls: Array<number> = [];
  for (const query of queries) {
    const [duration, [vector]] = yield* Effect.timed(ai.embed({ model, values: [query.query] }));
    millis.push(Duration.toMillis(duration));
    const ranked = corpus
      .map((repo, index) => ({ repo: repo.fullName, score: cosine(vector ?? [], documents[index] ?? []) }))
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.repo);
    recalls.push(recallAt(ranked, query.expected));
  }
  return { recall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length, medianMillis: median(millis) };
});

const best = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((left, right) => right.recall - left.recall || left.medianMillis - right.medianMillis)[0];

const formatRow = (row: Row) =>
  [
    row.stage.padEnd(10),
    row.model.padEnd(32),
    row.recall.toFixed(3).padStart(9),
    row.medianMillis.toFixed(0).padStart(10),
    (Number.isNaN(row.cost) ? "n/a" : `$${row.cost.toFixed(4)}`).padStart(10),
    String(row.failures).padStart(8),
  ].join(" ");

const modelsSource = (summary: string, embedding: Models.EmbeddingModel) => `export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
}

export const summaryModel = ${JSON.stringify(summary)};

export const embeddingModel: EmbeddingModel = { id: ${JSON.stringify(embedding.id)}, dimensions: ${embedding.dimensions} };
`;

const runBakeoff = Effect.fn("Bakeoff.run")(function* (fake: boolean) {
  const queries = yield* readText(queriesPath).pipe(Effect.flatMap(decodeQueries));
  const corpus = yield* readText(corpusPath).pipe(
    Effect.flatMap(decodeCorpus),
    Effect.catchTag("BakeoffFailed", () =>
      Effect.fail(new BakeoffFailed({ reason: "no corpus, run `bun run evals/bakeoff.ts corpus` first" })),
    ),
  );
  const pricing = yield* loadPricing;
  yield* Console.log(
    `${fake ? "Fake" : "Gateway"} bakeoff: ${queries.length} queries over ${corpus.length} repos, recall at ${topK}`,
  );

  const baseline = Models.summaryModel;
  const baselineRun = yield* withCost(pricing, baseline, summarizeCorpus(baseline, corpus));

  const embeddingRows: Array<Row> = [];
  for (const model of embeddingCandidates) {
    const { result, cost } = yield* withCost(
      pricing,
      model.id,
      scoreRetrieval(model, corpus, baselineRun.result.texts, queries),
    );
    embeddingRows.push({ stage: "embedding", model: model.id, ...result, cost, failures: 0 });
  }
  const embeddingWinner = embeddingCandidates.find((model) => model.id === best(embeddingRows)?.model);
  if (embeddingWinner === undefined) return yield* new BakeoffFailed({ reason: "no embedding model scored" });

  const summaryRows: Array<Row> = [];
  for (const model of summaryCandidates) {
    const { result: run, cost } =
      model === baseline ? baselineRun : yield* withCost(pricing, model, summarizeCorpus(model, corpus));
    const score = yield* scoreRetrieval(embeddingWinner, corpus, run.texts, queries);
    summaryRows.push({
      stage: "summary",
      model,
      recall: score.recall,
      medianMillis: median(run.millis),
      cost,
      failures: run.failures,
    });
  }
  const summaryWinner = best(summaryRows)?.model ?? baseline;

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
  yield* Console.log(
    `Chosen: summary ${summaryWinner}, embedding ${embeddingWinner.id} at ${embeddingWinner.dimensions} dimensions`,
  );

  if (fake) return yield* Console.log("Fake run, packages/ai/src/models.ts left unchanged");
  yield* writeText(modelsPath, modelsSource(summaryWinner, embeddingWinner));
  yield* Console.log("Wrote packages/ai/src/models.ts");
});

const runCorpus = Effect.gen(function* () {
  const queries = yield* readText(queriesPath).pipe(Effect.flatMap(decodeQueries));
  const repos = expectedRepos(queries);
  const { corpus, problems } = yield* fetchCorpus(repos);
  yield* writeText(corpusPath, yield* encodeCorpus(corpus));
  const withReadme = corpus.filter((repo) => repo.readme !== null).length;
  yield* Console.log(
    `Wrote ${corpus.length} of ${repos.length} repos to evals/.cache/corpus.json, ${withReadme} with a README`,
  );
  if (problems.length > 0) {
    for (const problem of problems) yield* Console.log(problem);
    return yield* new BakeoffFailed({ reason: `${problems.length} expected repos need fixing in evals/queries.json` });
  }
});

const args = Bun.argv.slice(2);
const fake = args.includes("--fake");

const aiLayer = fake
  ? AiFake.layer()
  : Layer.unwrap(Config.Redacted("AI_GATEWAY_API_KEY").pipe(Effect.map((apiKey) => Ai.layerGateway({ apiKey }))));

const main = Effect.gen(function* () {
  if (args[0] === "corpus") return yield* runCorpus;
  return yield* runBakeoff(fake).pipe(Effect.provide(aiLayer));
});

await Effect.runPromise(main.pipe(Effect.provide(FetchHttpClient.layer)));
