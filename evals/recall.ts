import * as BunServices from "@effect/platform-bun/BunServices";
import * as Embeddings from "@stargrep/ai/embeddings";
import { AiRequestFailed } from "@stargrep/ai/errors";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import { tokensSpent } from "@stargrep/ai/port";
import * as TextGeneration from "@stargrep/ai/text-generation";
import { QueryPlanner, Search, SearchCache } from "@stargrep/core/search";
import * as Db from "@stargrep/db";
import { Embedding, EmbeddingModelId } from "@stargrep/db/embedding";
import { createMigratedDatabase } from "@stargrep/db/local-database";
import * as Memory from "@stargrep/db/memory";
import { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Corpus from "./corpus.ts";
import { EnrichedRepo, enrich } from "./enriched-corpus.ts";

const bar = 0.97;
const topK = 10;
const accountId = GitHubAccountId.make(1);
const login = Login.make("recall-eval");
const scope = { _tag: "stars", login } as const;
const negativesPerQuery = 3;

const FixtureMeta = Schema.Struct({ recall: Schema.Finite, queries: Schema.Array(Schema.String) });
const Answer = Schema.Struct({ namespace: Schema.String, text: Schema.String, value: Schema.Unknown });
type Answer = typeof Answer.Type;

interface Fixture {
  readonly recall: number;
  readonly queries: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<EnrichedRepo>;
  readonly answers: ReadonlyArray<Answer>;
}

const fixtureFile = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));

const readLines = <A, I>(name: string, schema: Schema.Codec<A, I>) => {
  const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
  return Effect.promise(() => fixtureFile(name).text()).pipe(
    Effect.flatMap((text) => Effect.forEach(text.split("\n").filter(Boolean), (line) => decode(line))),
  );
};

const writeLines = <A, I>(name: string, schema: Schema.Codec<A, I>, values: ReadonlyArray<A>) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return Effect.forEach(values, (value) => encode(value)).pipe(
    Effect.flatMap((lines) => Effect.promise(() => Bun.write(fixtureFile(name), `${lines.join("\n")}\n`))),
  );
};

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);
const embeddingModelId = Schema.decodeSync(EmbeddingModelId)(Models.embeddingModel.id);

const starredAt = (index: number) =>
  DateTime.add(DateTime.makeUnsafe("2024-01-01T00:00:00Z"), { days: (index * 37) % 1030 });

const loadAccount = Effect.fn("Recall.loadAccount")(function* (repos: ReadonlyArray<EnrichedRepo>) {
  const db = yield* Db.Db;
  const rows = [...repos]
    .sort((left, right) => left.fullName.localeCompare(right.fullName))
    .map((repo, index) => {
      const [owner = "", name = ""] = repo.fullName.split("/");
      const id = RepoId.make(index + 1);
      return {
        repo,
        ref: { id, nodeId: RepoNodeId.make(`R_recall_${id}`), owner: Login.make(owner), name: RepoName.make(name) },
      };
    });
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login,
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  yield* db.repos.upsertRefs(rows.map((row) => row.ref));
  yield* Effect.forEach(
    rows,
    ({ repo, ref }) =>
      Effect.gen(function* () {
        yield* db.repos.saveFacts({
          ...ref,
          description: repo.description,
          topics: repo.topics,
          language: repo.language,
          license: null,
          homepage: null,
          createdAt: null,
          pushedAt: null,
          archived: false,
          readmeOid: null,
          ownerType: null,
          ownerAvatarUrl: null,
        });
        yield* db.repos.saveSummary({
          id: ref.id,
          readmeOid: null,
          summary: repo.summary,
          keywords: repo.keywords,
          kind: repo.kind,
        });
        const embedding = yield* decodeEmbedding({ model: embeddingModelId, vector: repo.vector }).pipe(Effect.orDie);
        yield* db.repos.saveEmbedding({ id: ref.id, embedding, summary: repo.summary, readmeOid: null });
      }),
    { concurrency: 8, discard: true },
  );
  yield* db.stars.upsert({
    accountId,
    stars: rows.map(({ ref }, index) => ({
      repoId: ref.id,
      starredAt: starredAt(index),
      observedAt: starredAt(index),
      source: "api",
    })),
  });
});

interface Scored {
  readonly query: Corpus.Query;
  readonly found: ReadonlyArray<string>;
  readonly source: QueryPlanner.PlanSource;
  readonly recall: number;
}

const runQueries = Effect.fn("Recall.runQueries")(function* (queries: ReadonlyArray<Corpus.Query>) {
  const search = yield* Search.Search;
  return yield* Effect.forEach(
    queries,
    (query) =>
      search.search({ scope, query: query.query, limit: topK }).pipe(
        Effect.map((outcome): Scored => {
          const found = outcome.results.map((result) => `${result.repo.owner}/${result.repo.name}`);
          const hits = query.expected.filter((name) => found.includes(name)).length;
          return { query, found, source: outcome.planSource, recall: hits / query.expected.length };
        }),
      ),
    { concurrency: 4 },
  );
});

const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length;

const report = Effect.fn("Recall.report")(function* (scored: ReadonlyArray<Scored>, repoCount: number) {
  const recall = mean(scored.map((entry) => entry.recall));
  yield* Console.log(`recall@${topK} over ${scored.length} queries and ${repoCount} repos: ${recall.toFixed(3)}`);
  const categories = [...new Set(scored.map((entry) => entry.query.category))].sort();
  for (const category of categories) {
    const inCategory = scored.filter((entry) => entry.query.category === category);
    yield* Console.log(
      `  ${category.padEnd(12)} ${String(inCategory.length).padStart(3)} queries  ${mean(inCategory.map((entry) => entry.recall)).toFixed(3)}`,
    );
  }
  const sources = Object.groupBy(scored, (entry) => entry.source);
  yield* Console.log(
    `plans: ${Object.entries(sources)
      .map(([source, entries]) => `${entries?.length ?? 0} ${source}`)
      .join(", ")}`,
  );
  for (const entry of scored.filter((item) => item.recall < 1)) {
    const missing = entry.query.expected.filter((name) => !entry.found.includes(name));
    yield* Console.log(`miss ${entry.query.id} "${entry.query.query}": ${missing.join(", ")}`);
  }
  return recall;
});

const layerSearch = <E1, R1, E2, R2>(
  text: Layer.Layer<TextGeneration.TextGeneration, E1, R1>,
  cache: Layer.Layer<SearchCache.SearchCache, E2, R2>,
) => Search.layer.pipe(Layer.provideMerge(QueryPlanner.layer.pipe(Layer.provide(text))), Layer.provideMerge(cache));

const tokenCounts = Effect.forEach([Models.plannerModel, Models.embeddingModel.id], (model) =>
  tokensSpent(model).pipe(Effect.map(({ input, output }) => `${model} ${input} in, ${output} out`)),
);

const recording = <E, R>(inner: Layer.Layer<SearchCache.SearchCache, E, R>, seen: Array<Answer>) =>
  Layer.effect(
    SearchCache.SearchCache,
    Effect.gen(function* () {
      const cache = yield* SearchCache.SearchCache;
      return SearchCache.SearchCache.of({
        lookup: Effect.fn("RecordingCache.lookup")(function* <A>(entry: SearchCache.Entry<A>, text: string) {
          const hit = yield* cache.lookup(entry, text);
          if (Option.isSome(hit)) {
            const value = yield* Schema.encodeEffect(entry.schema)(hit.value).pipe(Effect.orDie);
            seen.push({ namespace: entry.namespace, text, value });
          }
          return hit;
        }),
        store: cache.store,
      });
    }),
  ).pipe(Layer.provide(inner));

const answered = (answers: ReadonlyArray<Answer>) =>
  Layer.succeed(
    SearchCache.SearchCache,
    SearchCache.SearchCache.of({
      lookup: Effect.fn("FixtureCache.lookup")(function* <A>(entry: SearchCache.Entry<A>, text: string) {
        const answer = answers.find((candidate) => candidate.namespace === entry.namespace && candidate.text === text);
        if (answer === undefined) return Option.none<A>();
        return Option.some(yield* Schema.decodeUnknownEffect(entry.schema)(answer.value).pipe(Effect.orDie));
      }),
      store: Effect.fn("FixtureCache.store")(function* () {
        yield* Effect.void;
      }),
    }),
  );

const stale = (operation: "generate" | "embed", model: string) =>
  new AiRequestFailed({
    operation,
    model,
    detail: "the recall fixture has no cached answer, so rerun `bun run evals/recall.ts --write-fixture`",
  });

const layerFixtureAi = Layer.merge(
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({
      provider: "fixture",
      model: Models.plannerModel,
      timeout: Duration.seconds(1),
      run: () => Effect.fail(stale("generate", Models.plannerModel)),
    }),
  ),
  Layer.succeed(
    Embeddings.Embeddings,
    Embeddings.make({
      provider: "fixture",
      model: Models.embeddingModel,
      timeout: Duration.seconds(1),
      run: () => Effect.fail(stale("embed", Models.embeddingModel.id)),
    }),
  ),
);

class FixtureStale extends Schema.TaggedError<FixtureStale>()("FixtureStale", {
  queries: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `the planner fell back for ${this.queries.join(", ")}, so the fixture is stale: rerun \`bun run evals/recall.ts --write-fixture\``;
  }
}

const runFixture = Effect.fn("Recall.runFixture")(function* (fixture: Fixture) {
  const queries = (yield* Corpus.loadQueries).filter((query) => fixture.queries.includes(query.id));
  const layer = layerSearch(layerFixtureAi, answered(fixture.answers)).pipe(
    Layer.provideMerge(layerFixtureAi),
    Layer.provideMerge(Memory.layerMemory({ embeddingModel: embeddingModelId })),
  );
  return yield* Effect.gen(function* () {
    yield* loadAccount(fixture.repos);
    const scored = yield* runQueries(queries);
    const fellBack = scored.filter((entry) => entry.source === "fallback").map((entry) => entry.query.id);
    if (fellBack.length > 0) return yield* new FixtureStale({ queries: fellBack });
    return scored;
  }).pipe(Effect.provide(layer));
});

const fixtureQueries = (queries: ReadonlyArray<Corpus.Query>) =>
  [...new Set(queries.map((query) => query.category))].flatMap((category) =>
    queries.filter((query) => query.category === category).slice(0, 1),
  );

const fileCache = SearchCache.layerKeyValueStore.pipe(
  Layer.provide(KeyValueStore.layerFileSystem(new URL("./.cache/search", import.meta.url).pathname)),
  Layer.provide(BunServices.layer),
);

const writeFixture = Effect.fn("Recall.writeFixture")(function* (
  repos: ReadonlyArray<EnrichedRepo>,
  scored: ReadonlyArray<Scored>,
) {
  const chosen = fixtureQueries(scored.map((entry) => entry.query));
  const names = new Set(
    scored
      .filter((entry) => chosen.includes(entry.query))
      .flatMap((entry) => [
        ...entry.query.expected,
        ...entry.found.filter((name) => !entry.query.expected.includes(name)).slice(0, negativesPerQuery),
      ]),
  );
  const seen: Array<Answer> = [];
  yield* runQueries(chosen).pipe(
    Effect.provide(layerSearch(Gateway.layerPlannerTextGeneration, recording(fileCache, seen)), { local: true }),
  );
  const answers = [...new Map(seen.map((answer) => [`${answer.namespace}\n${answer.text}`, answer])).values()].sort(
    (left, right) => left.namespace.localeCompare(right.namespace) || left.text.localeCompare(right.text),
  );
  const draft: Fixture = {
    recall: 0,
    queries: chosen.map((query) => query.id),
    repos: repos.filter((repo) => names.has(repo.fullName)),
    answers,
  };
  const recall = mean((yield* runFixture(draft)).map((entry) => entry.recall));
  const meta = yield* Schema.encodeEffect(Schema.fromJsonString(FixtureMeta))({ recall, queries: draft.queries });
  yield* Effect.promise(() => Bun.write(fixtureFile("recall.json"), `${meta}\n`));
  yield* writeLines("recall-repos.jsonl", EnrichedRepo, draft.repos);
  yield* writeLines("recall-answers.jsonl", Answer, draft.answers);
  const planned = scored.filter((entry) => chosen.includes(entry.query) && entry.source !== "keyword").length;
  yield* Console.log(
    `Wrote evals/fixtures: ${draft.queries.length} queries (${planned} planned), ${draft.repos.length} repos, ${answers.length} answers, recall ${recall.toFixed(3)}`,
  );
});

class RecallBelowBar extends Schema.TaggedError<RecallBelowBar>()("RecallBelowBar", {
  recall: Schema.Finite,
  bar: Schema.Finite,
}) {
  override get message(): string {
    return `recall@${topK} is ${this.recall.toFixed(3)}, under the bar of ${this.bar.toFixed(3)}`;
  }
}

const real = Effect.fn("Recall.real")(function* (options: {
  readonly summaryModel: string;
  readonly writeFixture: boolean;
}) {
  const repos = yield* enrich(options.summaryModel).pipe(
    Effect.provide(Gateway.layerTextGeneration(options.summaryModel).pipe(Layer.provide(Gateway.layerProviderConfig))),
  );
  const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
  const url = yield* createMigratedDatabase(adminUrl, "stargrep_recall");
  yield* Console.log(`Loaded ${repos.length} repos as the stars of recall-eval in ${new URL(url).pathname.slice(1)}`);
  const db = Db.layerNodePostgres({ embeddingModel: embeddingModelId, connectionString: Redacted.make(url) });
  return yield* Effect.gen(function* () {
    yield* loadAccount(repos);
    const scored = yield* runQueries(yield* Corpus.loadQueries).pipe(
      Effect.provide(layerSearch(Gateway.layerPlannerTextGeneration, fileCache), { local: true }),
    );
    const recall = yield* report(scored, repos.length);
    yield* Console.log(`tokens: ${(yield* tokenCounts).join("; ")}`);
    if (options.writeFixture) yield* writeFixture(repos, scored);
    if (recall < bar) return yield* new RecallBelowBar({ recall, bar });
  }).pipe(Effect.provide(db));
});

const fixture = Effect.gen(function* () {
  const meta = yield* Effect.promise(() => fixtureFile("recall.json").text()).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureMeta))),
  );
  const loaded: Fixture = {
    ...meta,
    repos: yield* readLines("recall-repos.jsonl", EnrichedRepo),
    answers: yield* readLines("recall-answers.jsonl", Answer),
  };
  const scored = yield* runFixture(loaded);
  const recall = yield* report(scored, loaded.repos.length);
  yield* Console.log(`recorded fixture recall: ${loaded.recall.toFixed(3)}`);
  if (recall < loaded.recall) return yield* new RecallBelowBar({ recall, bar: loaded.recall });
});

const args = Bun.argv.slice(2);
const summaryIndex = args.indexOf("--summary-model");

const main = args.includes("--fixture")
  ? fixture
  : real({
      summaryModel: summaryIndex === -1 ? Models.summaryModel : (args[summaryIndex + 1] ?? Models.summaryModel),
      writeFixture: args.includes("--write-fixture"),
    }).pipe(
      Effect.provide(Gateway.layerEmbeddings(Models.embeddingModel).pipe(Layer.provide(Gateway.layerProviderConfig))),
    );

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(main.pipe(Effect.tapError((error) => Console.error(error.message))));
  if (exit._tag === "Failure") process.exit(1);
}
