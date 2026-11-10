import * as BunServices from "@effect/platform-bun/BunServices";
import * as Embeddings from "@stargrep/ai/embeddings";
import { AiRequestFailed } from "@stargrep/ai/errors";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import { tokensSpent } from "@stargrep/ai/port";
import * as TextGeneration from "@stargrep/ai/text-generation";
import { Compile, ModelAllowance, QueryPlanner, Search, SearchCache } from "@stargrep/core/search";
import * as Db from "@stargrep/db";
import { anyDistance } from "@stargrep/db/embedding";
import { createMigratedDatabase, databaseUrl, dropDatabase } from "@stargrep/db/local-database";
import * as Memory from "@stargrep/db/memory";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { acceptFloor, embeddingModelId, loadAccount, scope } from "./account.ts";
import { judgedRepos } from "./behavior.ts";
import * as Corpus from "./corpus.ts";
import { EnrichedRepo, enrich } from "./enriched-corpus.ts";

const bar = 0.97;
const topK = 10;
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

interface Sets<A> {
  readonly queries: A;
  readonly typos: A;
  readonly nonsense: A;
}

const loadSets = Effect.all({ queries: Corpus.loadQueries, typos: Corpus.loadTypos, nonsense: Corpus.loadNonsense });

const runSets = (sets: Sets<ReadonlyArray<Corpus.Query>>) =>
  Effect.all({ queries: runQueries(sets.queries), typos: runQueries(sets.typos), nonsense: runQueries(sets.nonsense) });

const typosMissed = (typos: ReadonlyArray<Scored>) => typos.filter((entry) => entry.recall < 1);

const nonsenseAnswered = (nonsense: ReadonlyArray<Scored>) => nonsense.filter((entry) => entry.found.length > 0);

const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length;

const report = Effect.fn("Recall.report")(function* (results: Sets<ReadonlyArray<Scored>>, repoCount: number) {
  const scored = results.queries;
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
  const missedTypos = typosMissed(results.typos);
  yield* Console.log(`typos found: ${results.typos.length - missedTypos.length} of ${results.typos.length}`);
  for (const entry of missedTypos) {
    yield* Console.log(`miss ${entry.query.id} "${entry.query.query}": ${entry.query.expected.join(", ")}`);
  }
  const answered = nonsenseAnswered(results.nonsense);
  yield* Console.log(
    `nonsense answered with nothing: ${results.nonsense.length - answered.length} of ${results.nonsense.length}`,
  );
  for (const entry of answered) {
    yield* Console.log(`answered ${entry.query.id} "${entry.query.query}": ${entry.found.slice(0, 3).join(", ")}`);
  }
  return recall;
});

class SearchChecksFailed extends Schema.TaggedError<SearchChecksFailed>()("SearchChecksFailed", {
  typosMissed: Schema.Array(Schema.String),
  nonsenseAnswered: Schema.Array(Schema.String),
}) {
  override get message(): string {
    const failures = [
      ...(this.typosMissed.length === 0 ? [] : [`missed typos ${this.typosMissed.join(", ")}`]),
      ...(this.nonsenseAnswered.length === 0 ? [] : [`answered nonsense ${this.nonsenseAnswered.join(", ")}`]),
    ];
    return `search ${failures.join(" and ")}`;
  }
}

const checkTyposAndNonsense = (results: Sets<ReadonlyArray<Scored>>) => {
  const missed = typosMissed(results.typos).map((entry) => entry.query.id);
  const answered = nonsenseAnswered(results.nonsense).map((entry) => entry.query.id);
  return missed.length === 0 && answered.length === 0
    ? Effect.void
    : Effect.fail(new SearchChecksFailed({ typosMissed: missed, nonsenseAnswered: answered }));
};

const layerSearch = <E1, R1, E2, R2>(
  text: Layer.Layer<TextGeneration.TextGeneration, E1, R1>,
  cache: Layer.Layer<SearchCache.SearchCache, E2, R2>,
) =>
  Search.layer.pipe(
    Layer.provideMerge(QueryPlanner.layer.pipe(Layer.provide(text))),
    Layer.provideMerge(cache),
    Layer.provideMerge(ModelAllowance.layerUnmetered),
  );

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
  const sets = yield* loadSets;
  const inFixture = (queries: ReadonlyArray<Corpus.Query>) =>
    queries.filter((query) => fixture.queries.includes(query.id));
  const layer = layerSearch(layerFixtureAi, answered(fixture.answers)).pipe(
    Layer.provideMerge(layerFixtureAi),
    Layer.provideMerge(Memory.layerMemory({ embeddingModel: embeddingModelId })),
  );
  return yield* Effect.gen(function* () {
    yield* loadAccount(fixture.repos);
    const results = yield* runSets({
      queries: inFixture(sets.queries),
      typos: inFixture(sets.typos),
      nonsense: inFixture(sets.nonsense),
    });
    const fellBack = [...results.queries, ...results.typos, ...results.nonsense]
      .filter((entry) => entry.source === "fallback")
      .map((entry) => entry.query.id);
    if (fellBack.length > 0) return yield* new FixtureStale({ queries: fellBack });
    return results;
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
  results: Sets<ReadonlyArray<Scored>>,
) {
  const chosen: Sets<ReadonlyArray<Corpus.Query>> = {
    queries: fixtureQueries(results.queries.map((entry) => entry.query)),
    typos: fixtureQueries(results.typos.map((entry) => entry.query)),
    nonsense: fixtureQueries(results.nonsense.map((entry) => entry.query)),
  };
  const ids = [...chosen.queries, ...chosen.typos, ...chosen.nonsense].map((query) => query.id);
  const names = new Set(
    [...results.queries, ...results.typos]
      .filter((entry) => ids.includes(entry.query.id))
      .flatMap((entry) => [
        ...entry.query.expected,
        ...entry.found.filter((name) => !entry.query.expected.includes(name)).slice(0, negativesPerQuery),
      ]),
  );
  const seen: Array<Answer> = [];
  yield* runSets(chosen).pipe(
    Effect.provide(layerSearch(Gateway.layerPlannerTextGeneration, recording(fileCache, seen)), { local: true }),
  );
  const answers = [...new Map(seen.map((answer) => [`${answer.namespace}\n${answer.text}`, answer])).values()].sort(
    (left, right) => left.namespace.localeCompare(right.namespace) || left.text.localeCompare(right.text),
  );
  const draft: Fixture = {
    recall: 0,
    queries: ids,
    repos: repos.filter((repo) => names.has(repo.fullName)),
    answers,
  };
  const recall = mean((yield* runFixture(draft)).queries.map((entry) => entry.recall));
  const meta = yield* Schema.encodeEffect(Schema.fromJsonString(FixtureMeta))({ recall, queries: draft.queries });
  yield* Effect.promise(() => Bun.write(fixtureFile("recall.json"), `${meta}\n`));
  yield* writeLines("recall-repos.jsonl", EnrichedRepo, draft.repos);
  yield* writeLines("recall-answers.jsonl", Answer, draft.answers);
  const planned = results.queries.filter(
    (entry) => chosen.queries.includes(entry.query) && entry.source !== "keyword",
  ).length;
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

const sweep = Effect.fn("Recall.sweep")(function* (
  sets: Sets<ReadonlyArray<Corpus.Query>>,
  maxDistances: ReadonlyArray<number>,
) {
  yield* Console.log(`max distance  recall@${topK}  typos found  nonsense answered`);
  for (const maxDistance of maxDistances) {
    const results = yield* runSets(sets).pipe(
      Effect.provide(
        layerSearch(Gateway.layerPlannerTextGeneration, fileCache).pipe(
          Layer.provide(
            Gateway.layerEmbeddings({ ...Models.embeddingModel, maxMatchDistance: maxDistance }).pipe(
              Layer.provide(Gateway.layerProviderConfig),
            ),
          ),
        ),
        { local: true },
      ),
    );
    const recall = mean(results.queries.map((entry) => entry.recall)).toFixed(3);
    const found = `${results.typos.length - typosMissed(results.typos).length}/${results.typos.length}`;
    const answered = `${nonsenseAnswered(results.nonsense).length}/${results.nonsense.length}`;
    yield* Console.log(
      `${maxDistance.toFixed(2).padStart(12)}  ${recall.padStart(9)}  ${found.padStart(11)}  ${answered.padStart(17)}`,
    );
  }
});

// Bare stated subjects as filters, a policy change this eval gates.
const bareFilters: Compile.Policy = { ...Compile.policy, bare: ["filter", "filter"] };

const real = Effect.fn("Recall.real")(function* (options: {
  readonly summaryModel: string;
  readonly writeFixture: boolean;
  readonly writeBehavior: boolean;
  readonly maxDistances: ReadonlyArray<number>;
  readonly acceptFloor: boolean;
  readonly bareFilters: boolean;
}) {
  const repos = yield* enrich(options.summaryModel).pipe(
    Effect.provide(Gateway.layerTextGeneration(options.summaryModel).pipe(Layer.provide(Gateway.layerProviderConfig))),
  );
  if (options.writeBehavior) {
    const kept = repos.filter((repo) => judgedRepos.includes(repo.fullName));
    yield* writeLines("behavior-repos.jsonl", EnrichedRepo, kept);
    return yield* Console.log(
      `Wrote evals/fixtures/behavior-repos.jsonl: ${kept.length} of ${judgedRepos.length} repos`,
    );
  }
  const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
  // A fresh database each run, so neither an earlier corpus nor the subjects an --accept-floor run accepted leak in. The
  // drop runs from the server's maintenance database, since DATABASE_URL may name stargrep_recall itself.
  const maintenance = databaseUrl(adminUrl, "postgres");
  yield* dropDatabase(maintenance, "stargrep_recall");
  const url = yield* createMigratedDatabase(maintenance, "stargrep_recall");
  yield* Console.log(`Loaded ${repos.length} repos as the stars of recall-eval in ${new URL(url).pathname.slice(1)}`);
  const db = Db.layerNodePostgres({ embeddingModel: embeddingModelId, connectionString: Redacted.make(url) });
  return yield* Effect.gen(function* () {
    yield* loadAccount(repos);
    if (options.acceptFloor) {
      const { accepted } = yield* acceptFloor();
      yield* Console.log(`Accepted ${accepted} subjects at the usage floor`);
    }
    const sets = yield* loadSets;
    if (options.maxDistances.length > 0) return yield* sweep(sets, options.maxDistances);
    const results = yield* runSets(sets).pipe(
      Effect.provide(layerSearch(Gateway.layerPlannerTextGeneration, fileCache), { local: true }),
      Effect.provideService(Compile.CurrentPolicy, options.bareFilters ? bareFilters : Compile.policy),
    );
    const recall = yield* report(results, repos.length);
    yield* Console.log(`tokens: ${(yield* tokenCounts).join("; ")}`);
    if (options.writeFixture) yield* writeFixture(repos, results);
    if (recall < bar) return yield* new RecallBelowBar({ recall, bar });
    yield* checkTyposAndNonsense(results);
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
  const results = yield* runFixture(loaded);
  const recall = yield* report(results, loaded.repos.length);
  yield* Console.log(`recorded fixture recall: ${loaded.recall.toFixed(3)}`);
  if (recall < loaded.recall) return yield* new RecallBelowBar({ recall, bar: loaded.recall });
  yield* checkTyposAndNonsense(results);
});

const MaxDistances = Schema.NonEmptyArray(
  Schema.FiniteFromString.check(Schema.isBetween({ minimum: 0, maximum: anyDistance, exclusiveMinimum: true })),
);

const args = Bun.argv.slice(2);
const summaryIndex = args.indexOf("--summary-model");
const maxDistancesIndex = args.indexOf("--max-distances");
const maxDistances =
  maxDistancesIndex === -1
    ? Effect.succeed<ReadonlyArray<number>>([])
    : Schema.decodeUnknownEffect(MaxDistances)((args[maxDistancesIndex + 1] ?? "").split(","));

const main = args.includes("--fixture")
  ? fixture
  : Effect.flatMap(maxDistances, (distances) =>
      real({
        summaryModel: summaryIndex === -1 ? Models.summaryModel : (args[summaryIndex + 1] ?? Models.summaryModel),
        writeFixture: args.includes("--write-fixture"),
        writeBehavior: args.includes("--write-behavior"),
        maxDistances: distances,
        acceptFloor: args.includes("--accept-floor"),
        bareFilters: args.includes("--bare-filters"),
      }),
    ).pipe(
      Effect.provide(Gateway.layerEmbeddings(Models.embeddingModel).pipe(Layer.provide(Gateway.layerProviderConfig))),
    );

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    main.pipe(
      Effect.tapError((error) => Console.error(error.message)),
      Effect.tapDefect((defect) => Console.error(Cause.pretty(Cause.die(defect)))),
    ),
  );
  if (exit._tag === "Failure") process.exit(1);
}
