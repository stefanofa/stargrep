import { expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import { Embedding, EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { SelectionKey } from "@stargrep/knowledge/atom";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { registry } from "./metric-registry.ts";
import * as ModelAllowance from "./model-allowance.ts";
import * as QueryPlan from "./query-plan.ts";
import * as QueryPlanner from "./query-planner.ts";
import { recordingEmbeddings, type Seed, seedLibrary } from "./search.fixture.ts";
import * as Search from "./search.ts";
import * as SearchCache from "./search-cache.ts";

const model = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const fixture = () => {
  const calls = { prompts: [] as Array<string>, embedded: [] as Array<string> };
  let respond: (prompt: string) => unknown = () => ({});

  const layerEmbeddings = recordingEmbeddings((values) => {
    calls.embedded.push(...values);
  });

  const layerSearch = <E>(db: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
    Search.layer.pipe(
      Layer.provideMerge(
        QueryPlanner.layer.pipe(
          Layer.provide(
            Fake.layerTextGeneration((prompt) => {
              calls.prompts.push(prompt);
              return respond(prompt);
            }, "fake/planner"),
          ),
        ),
      ),
      Layer.provideMerge(ModelAllowance.layerUnmetered),
      Layer.provideMerge(SearchCache.layerMemory),
      Layer.provideMerge(layerEmbeddings),
      Layer.provideMerge(db),
    );

  const seed = (account: number, repos: ReadonlyArray<Seed>) =>
    seedLibrary(account, repos).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          calls.prompts.length = 0;
          calls.embedded.length = 0;
        }),
      ),
    );

  const orms = (base: number): ReadonlyArray<Seed> => [
    {
      id: base + 1,
      name: "drizzle-orm",
      summary: "typescript orm for sql databases",
      language: "TypeScript",
      starredAt: "2025-03-01T00:00:00Z",
      stars: 30_000,
    },
    {
      id: base + 2,
      name: "prisma",
      summary: "typescript orm for sql databases with migrations",
      language: "TypeScript",
      starredAt: "2024-05-01T00:00:00Z",
      stars: 40_000,
    },
    {
      id: base + 3,
      name: "diesel",
      summary: "rust orm for sql databases",
      language: "Rust",
      starredAt: "2025-02-01T00:00:00Z",
      stars: 12_000,
    },
    {
      id: base + 4,
      name: "ratatui",
      summary: "rust library for terminal dashboards",
      language: "Rust",
      starredAt: "2025-04-01T00:00:00Z",
    },
  ];

  const encodeOutput = Schema.encodeSync(QueryPlan.PlannerOutput);

  const ormPlan = (
    filters: Partial<QueryPlan.PlannerFilters> = {},
    ranking: QueryPlan.Ranking = { _tag: "relevance" },
    semanticText = "typescript orm for sql databases",
  ) => encodeOutput({ semanticText, filters: { ...QueryPlan.noFilters, ...filters }, ranking });

  const names = (outcome: Search.SearchOutcome) => outcome.results.map((result): string => result.repo.name);

  const searchCases = (test: {
    readonly effect: it.Tester<
      | Search.Search
      | QueryPlanner.QueryPlanner
      | SearchCache.SearchCache
      | Db.Db
      | TestDatabase.TestDatabase
      | Embeddings.Embeddings
      | ModelAllowance.ModelAllowance
    >;
  }) => {
    const search = (request: Search.SearchRequest) =>
      Effect.flatMap(Effect.service(Search.Search), (service) => service.search(request));

    test.effect("applies the plan's filters and returns the ranks that placed each repo", () =>
      Effect.gen(function* () {
        const scope = yield* seed(901, orms(9100));
        respond = () =>
          ormPlan({
            languages: [{ language: "TypeScript", said: "typescript" }],
            starredAfter: DateTime.makeUnsafe("2025-01-01"),
            starredBefore: DateTime.makeUnsafe("2026-01-01"),
          });
        const outcome = yield* search({ scope, query: "typescript orm starred last year", limit: 10 });
        expect(outcome.planSource).toBe("model");
        expect(names(outcome)).toEqual(["drizzle-orm"]);
        expect(outcome.results.map(Search.reasonLine)).toEqual(["meaning match #1"]);
      }),
    );

    test.effect("orders the best matches by a metric and shows its value", () =>
      Effect.gen(function* () {
        const scope = yield* seed(902, orms(9200));
        respond = () =>
          ormPlan(
            { languages: [{ language: "TypeScript", said: "typescript" }] },
            { _tag: "metric", metric: "stars", direction: "highest" },
          );
        const outcome = yield* search({ scope, query: "most popular typescript orms", limit: 10 });
        expect(names(outcome)).toEqual(["prisma", "drizzle-orm"]);
        expect(outcome.results.map(Search.reasonLine)).toEqual([
          "meaning match #2, 40K stars",
          "meaning match #1, 30K stars",
        ]);
      }),
    );

    test.effect("puts an exact repo name first without asking the planner", () =>
      Effect.gen(function* () {
        const scope = yield* seed(903, orms(9300));
        const outcome = yield* search({ scope, query: "ratatui", limit: 10 });
        expect(outcome.planSource).toBe("keyword");
        expect(outcome.results[0]).toMatchObject({ repo: { name: "ratatui" }, nameMatch: true });
        expect(calls.prompts).toEqual([]);
      }),
    );

    test.effect("plans and embeds a repeated query once", () =>
      Effect.gen(function* () {
        const scope = yield* seed(904, orms(9400));
        respond = () => ormPlan({}, { _tag: "relevance" }, "an orm for typescript projects");
        const first = yield* search({ scope, query: "an orm for typescript projects", limit: 10 });
        const again = yield* search({ scope, query: "an orm for typescript projects", limit: 10 });
        expect([first.planSource, again.planSource]).toEqual(["model", "cache"]);
        expect(names(again)).toEqual(names(first));
        expect(calls.prompts).toHaveLength(1);
        expect(calls.embedded).toEqual(["an orm for typescript projects"]);
      }),
    );

    test.effect("returns no results, without an error, for a query that matches nothing", () =>
      Effect.gen(function* () {
        const scope = yield* seed(905, orms(9500));
        respond = () => ormPlan({ languages: [{ language: "COBOL", said: "cobol" }] });
        expect((yield* search({ scope, query: "cobol orms for mainframes", limit: 10 })).results).toEqual([]);
      }),
    );

    test.effect("answers gibberish with nothing after one planner call", () =>
      Effect.gen(function* () {
        const scope = yield* seed(916, orms(9020));
        respond = () => ormPlan({}, { _tag: "relevance" }, "a software project matching the unclear term dfsfgdsrg");
        const outcome = yield* search({ scope, query: "dfsfgdsrg", limit: 10 });
        expect([outcome.planSource, outcome.results]).toEqual(["model", []]);
        expect(calls.prompts).toHaveLength(1);
      }),
    );

    test.effect("finds a misspelled repo name through the planner when the typed word matches nothing", () =>
      Effect.gen(function* () {
        const scope = yield* seed(917, orms(9030));
        respond = () => ormPlan({}, { _tag: "relevance" }, "rust orm for sql databases");
        const outcome = yield* search({ scope, query: "deisel", limit: 10 });
        expect(outcome.planSource).toBe("model");
        expect(names(outcome)[0]).toBe("diesel");
        expect(names(outcome)).not.toContain("ratatui");
        expect(calls.prompts).toHaveLength(1);
      }),
    );

    test.effect("skips the planner for a word that still matches as a prefix, as while typing", () =>
      Effect.gen(function* () {
        const scope = yield* seed(918, orms(9040));
        const outcome = yield* search({ scope, query: "drizz", limit: 10 });
        expect([outcome.planSource, outcome.results, calls.prompts]).toEqual(["keyword", [], []]);
      }),
    );

    test.effect("answers nothing when the planner fails, without searching the same words again", () =>
      Effect.gen(function* () {
        const scope = yield* seed(919, orms(9050));
        respond = () => ({});
        const searched: Array<string> = [];
        const counting = Layer.effect(
          Db.Db,
          Effect.map(Effect.service(Db.Db), (db) =>
            Db.Db.of({
              ...db,
              search: {
                ...db.search,
                hybrid: (request) =>
                  Effect.sync(() => searched.push(request.text)).pipe(Effect.andThen(db.search.hybrid(request))),
              },
            }),
          ),
        );
        const service = yield* Search.make.pipe(Effect.provide(counting));
        const outcome = yield* service.search({ scope, query: "qwpoeiruty", limit: 10 });
        expect([outcome.planSource, outcome.results, searched]).toEqual(["fallback", [], ["qwpoeiruty"]]);
        expect(calls.prompts).toHaveLength(1);
      }),
    );

    test.effect("counts a keyword search that needed the planner once, under the plan it ran", () =>
      Effect.gen(function* () {
        const scope = yield* seed(920, orms(9060));
        respond = () => ormPlan({}, { _tag: "relevance" }, "typescript orm for sql databases with migrations");
        const count = (source: QueryPlanner.PlanSource) =>
          Effect.map(Metric.value(Metric.withAttributes(Search.plansMade, { source })), (state) => state.count);
        const keywordBefore = yield* count("keyword");
        const modelBefore = yield* count("model");
        expect(names(yield* search({ scope, query: "prsima", limit: 10 }))[0]).toBe("prisma");
        expect([yield* count("keyword"), yield* count("model")]).toEqual([keywordBefore, modelBefore + 1]);
      }),
    );

    test.effect("fails a filter that names a subject no one can use, and applies a known one", () =>
      Effect.gen(function* () {
        const scope = yield* seed(921, orms(9070));
        const filtered = (key: string) =>
          search({ scope, query: "ratatui", limit: 10, filter: Schema.decodeSync(SelectionKey)(key) });
        const error = yield* filtered("subject:999999999").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "FacetUnavailable", subjects: [999_999_999] });
        const rust = yield* filtered("lang:rust");
        expect([names(rust), names(yield* filtered("-lang:rust"))]).toEqual([["ratatui"], []]);
        expect(rust.applied).toEqual([
          { atom: "lang:rust", label: "Rust", mode: "filter", from: "filter", span: null },
        ]);
      }),
    );

    test.effect("tests the role each cue names, for languages and platforms, and excludes only that role", () =>
      Effect.gen(function* () {
        const app = (id: number, name: string, language: string, facts: Seed["facts"] = []): Seed => ({
          id,
          name,
          summary: "a desktop app",
          language,
          starredAt: "2025-01-01T00:00:00Z",
          kind: "app",
          facts,
        });
        const scope = yield* seed(922, [
          app(9221, "node-built", "Go", [{ role: "built_with", term: "Node.js" }]),
          app(9222, "node-target", "Go", [{ role: "for", term: "Node.js" }]),
          app(9223, "node-runtime", "Go", [{ role: "runs_on", term: "Node.js" }]),
          app(9224, "js-built", "Rust", [{ role: "built_with", term: "JavaScript" }]),
          app(9225, "js-written", "JavaScript"),
          app(9226, "ts-written", "TypeScript"),
          app(9227, "js-target", "Go", [{ role: "for", term: "JavaScript" }]),
        ]);
        respond = (prompt) =>
          ormPlan(
            /javascript/i.test(prompt) ? { languages: [{ language: "JavaScript", said: "javascript" }] } : {},
            { _tag: "relevance" },
            "a desktop app",
          );
        const everyApp = [
          "js-built",
          "js-target",
          "js-written",
          "node-built",
          "node-runtime",
          "node-target",
          "ts-written",
        ];
        const found = (query: string) =>
          search({ scope, query, limit: 10 }).pipe(Effect.map((outcome) => names(outcome)));
        const without = (...names: ReadonlyArray<string>) => everyApp.filter((name) => !names.includes(name));

        expect((yield* found("apps built with node")).sort()).toEqual(["node-built"]);
        expect((yield* found("apps not built with node")).sort()).toEqual(without("node-built"));
        expect((yield* found("apps that run on node")).sort()).toEqual(["node-runtime"]);
        expect((yield* found("apps not running on node")).sort()).toEqual(without("node-runtime"));
        const boosted = yield* found("apps for node");
        expect([boosted.slice(0, 2).sort(), boosted.sort()]).toEqual([["node-runtime", "node-target"], everyApp]);
        expect((yield* found("apps written in javascript")).sort()).toEqual(["js-written", "ts-written"]);
        // An exclusion removes exactly the language it names, so a TypeScript repo stays.
        expect((yield* found("apps not written in javascript")).sort()).toEqual(without("js-written"));
        // A language something is built with is most often the one it is written in.
        expect((yield* found("apps built with javascript")).sort()).toEqual(["js-built", "js-written", "ts-written"]);
        expect((yield* found("apps not built with javascript")).sort()).toEqual(without("js-built", "js-written"));
        expect((yield* found("javascript apps")).sort()).toEqual(["js-target", "js-written", "ts-written"]);
      }),
    );

    test.effect("refuses network and global scopes until they exist", () =>
      Effect.gen(function* () {
        for (const scope of [{ _tag: "network", login: Login.make("user-906") }, { _tag: "global" }] as const) {
          const error = yield* search({ scope, query: "ratatui", limit: 10 }).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "SearchScopeUnavailable", scope: scope._tag });
        }
      }),
    );

    test.effect("says a login without an account is not synced, before asking the planner", () =>
      Effect.gen(function* () {
        calls.prompts.length = 0;
        calls.embedded.length = 0;
        const scope = { _tag: "stars", login: Login.make("nobody-here") } as const;
        const error = yield* search({ scope, query: "an orm for typescript projects", limit: 10 }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AccountNotSynced", login: "nobody-here" });
        expect([calls.prompts, calls.embedded]).toEqual([[], []]);
      }),
    );

    test.effect("sends a short query that names a filter to the planner and keeps only repos that match it", () =>
      Effect.gen(function* () {
        const scope = yield* seed(910, [
          {
            id: 9951,
            name: "ts-cli",
            summary: "command line tool",
            language: "TypeScript",
            starredAt: "2025-01-01T00:00:00Z",
            kind: "cli",
            license: "MIT",
          },
          {
            id: 9952,
            name: "go-cli",
            summary: "command line tool",
            language: "Go",
            starredAt: "2025-01-01T00:00:00Z",
            kind: "cli",
            license: "Apache-2.0",
          },
          {
            id: 9953,
            name: "gpl-lib",
            summary: "command line library",
            language: "Rust",
            starredAt: "2025-01-01T00:00:00Z",
            kind: "library",
            license: "GPL-3.0",
          },
          {
            id: 9954,
            name: "mit-lib",
            summary: "command line library",
            language: "TypeScript",
            starredAt: "2025-01-01T00:00:00Z",
            kind: "library",
            license: "MIT",
          },
        ]);
        respond = (prompt) =>
          prompt.includes("TypeScript CLIs")
            ? ormPlan(
                { languages: [{ language: "TypeScript", said: "TypeScript" }], kinds: ["cli"] },
                { _tag: "relevance" },
                "a command line tool",
              )
            : ormPlan({ licenses: ["MIT"], kinds: ["library"] }, { _tag: "relevance" }, "a command line library");
        const tsClis = yield* search({ scope, query: "only TypeScript CLIs", limit: 10 });
        const mitLibraries = yield* search({ scope, query: "only MIT libraries", limit: 10 });
        expect([tsClis.planSource, mitLibraries.planSource]).toEqual(["model", "model"]);
        expect(calls.prompts).toHaveLength(2);
        expect(names(tsClis)).toEqual(["ts-cli"]);
        expect(names(mitLibraries)).toEqual(["mit-lib"]);
      }),
    );

    test.effect("keeps a repo with exactly the bound out of 'more than' and in 'at least'", () =>
      Effect.gen(function* () {
        const scope = yield* seed(911, [
          {
            id: 9961,
            name: "two-hundred",
            summary: "chart library",
            language: "Go",
            starredAt: "2025-01-01T00:00:00Z",
            stars: 200,
          },
          {
            id: 9962,
            name: "three-hundred",
            summary: "chart library",
            language: "Go",
            starredAt: "2025-01-01T00:00:00Z",
            stars: 300,
          },
        ]);
        respond = (prompt) =>
          ormPlan(
            { metrics: [{ metric: "stars", op: prompt.includes("more than") ? "gt" : "gte", value: 200 }] },
            { _tag: "relevance" },
            "a chart library",
          );
        const moreThan = yield* search({ scope, query: "chart libraries with more than 200 stars", limit: 10 });
        const atLeast = yield* search({ scope, query: "chart libraries with at least 200 stars", limit: 10 });
        expect(names(moreThan)).toEqual(["three-hundred"]);
        expect(names(atLeast).sort()).toEqual(["three-hundred", "two-hundred"]);
      }),
    );

    test.effect("keeps a language named in another language and returns only repos in it", () =>
      Effect.gen(function* () {
        const scope = yield* seed(912, [
          {
            id: 9971,
            name: "flask",
            summary: "python web framework",
            language: "Python",
            starredAt: "2025-01-01T00:00:00Z",
          },
          {
            id: 9972,
            name: "actix-web",
            summary: "rust web framework",
            language: "Rust",
            starredAt: "2025-01-01T00:00:00Z",
          },
          {
            id: 9973,
            name: "express",
            summary: "javascript web framework",
            language: "JavaScript",
            starredAt: "2025-01-01T00:00:00Z",
          },
        ]);
        respond = () =>
          ormPlan(
            { languages: [{ language: "Python", said: "питоне" }] },
            { _tag: "relevance" },
            "a python web framework",
          );
        const outcome = yield* search({ scope, query: "библиотеки на питоне для веба", limit: 10 });
        expect(outcome.plan.filters.languages).toEqual(["Python"]);
        expect(names(outcome)).toEqual(["flask"]);
      }),
    );

    test.effect("keeps a Kotlin starter when the model quotes a framework as Java", () =>
      Effect.gen(function* () {
        const scope = yield* seed(914, [
          {
            id: 9981,
            name: "java-spring-starter",
            summary: "spring boot starter",
            language: "Java",
            starredAt: "2025-01-01T00:00:00Z",
          },
          {
            id: 9982,
            name: "kotlin-spring-starter",
            summary: "spring boot starter",
            language: "Kotlin",
            starredAt: "2025-01-01T00:00:00Z",
          },
        ]);
        respond = () =>
          ormPlan(
            { languages: [{ language: "Java", said: "spring boot" }] },
            { _tag: "relevance" },
            "a spring boot starter",
          );
        const outcome = yield* search({ scope, query: "spring boot starter", limit: 10 });
        expect(outcome.plan.filters.languages).toEqual([]);
        expect(names(outcome).sort()).toEqual(["java-spring-starter", "kotlin-spring-starter"]);
      }),
    );

    test.effect("keeps a language named inside Chinese text and returns only repos in it", () =>
      Effect.gen(function* () {
        const scope = yield* seed(915, [
          {
            id: 9991,
            name: "fastapi",
            summary: "python web framework",
            language: "Python",
            starredAt: "2025-01-01T00:00:00Z",
          },
          { id: 9992, name: "gin", summary: "go web framework", language: "Go", starredAt: "2025-01-01T00:00:00Z" },
        ]);
        respond = () =>
          ormPlan(
            { languages: [{ language: "Python", said: "Python" }] },
            { _tag: "relevance" },
            "a python web framework",
          );
        const outcome = yield* search({ scope, query: "用Python写的网络框架", limit: 10 });
        expect(outcome.plan.filters.languages).toEqual(["Python"]);
        expect(names(outcome)).toEqual(["fastapi"]);
      }),
    );

    test.effect("runs every registry metric as a filter and a ranking in the database", () =>
      Effect.gen(function* () {
        yield* seed(907, orms(9700));
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const embeddings = yield* Embeddings.Embeddings;
        const filled = Db.MetricFamily.literals.flatMap((family) => [
          `${family} = coalesce(${family}, 100)`,
          `${family}_30d = coalesce(${family}_30d, 1)`,
          `${family}_90d = coalesce(${family}_90d, 1)`,
        ]);
        yield* database.query(`update repo_metrics set ${filled.join(", ")}`);
        const [query] = yield* embeddings.embed(["typescript orm"]);
        const embedding = yield* decodeEmbedding({ model, vector: query?.vector });
        for (const metric of Object.values(registry)) {
          const hits = yield* db.search
            .hybrid({
              scope: { kind: "stars", accountId: GitHubAccountId.make(907) },
              text: "orm",
              embedding,
              maxDistance: embeddings.model.maxMatchDistance,
              limit: 10,
              name: null,
              metrics: [metric],
              filters: { ...Db.noFilters, metrics: [{ metric: metric.id, op: "gt", value: -1e12 }] },
              atoms: Db.noAtoms,
              rankBy: { metric: metric.id, direction: "highest" },
            })
            .pipe(Effect.map(({ hits }) => hits));
          expect([metric.id, hits.length, hits.every((hit) => hit.metrics[0] !== null)]).toEqual([metric.id, 3, true]);
        }
      }),
    );

    test.effect("embeds every query when the cache fails", () =>
      Effect.gen(function* () {
        const scope = yield* seed(908, orms(9800));
        const broken = Layer.effect(
          SearchCache.SearchCache,
          SearchCache.make({
            get: () => Effect.fail(new SearchCache.SearchCacheFailed({ operation: "get", cause: new Error("down") })),
            set: () => Effect.fail(new SearchCache.SearchCacheFailed({ operation: "set", cause: new Error("down") })),
          }),
        ).pipe(Layer.provide(Digest.layerWebCrypto));
        const service = yield* Search.make.pipe(Effect.provide(broken));
        const first = yield* service.search({ scope, query: "drizzle-orm", limit: 10 });
        yield* service.search({ scope, query: "drizzle-orm", limit: 10 });
        expect(first.results[0]).toMatchObject({ repo: { name: "drizzle-orm" }, nameMatch: true });
        expect(calls.embedded).toEqual(["drizzle-orm", "drizzle-orm"]);
      }),
    );

    test.effect("re-embeds a query whose cached vector is corrupt instead of failing", () =>
      Effect.gen(function* () {
        const scope = yield* seed(913, orms(9990));
        const corrupt = Layer.effect(
          SearchCache.SearchCache,
          SearchCache.make({
            get: (key) =>
              Effect.succeed(
                key.startsWith("embedding/")
                  ? Option.some(JSON.stringify({ text: "prisma", expiresAt: 8.64e15, value: "AQ==" }))
                  : Option.none(),
              ),
            set: () => Effect.void,
          }),
        ).pipe(Layer.provide(Digest.layerWebCrypto));
        const service = yield* Search.make.pipe(Effect.provide(corrupt));
        const outcome = yield* service.search({ scope, query: "prisma", limit: 10 });
        expect(outcome.results[0]).toMatchObject({ repo: { name: "prisma" }, nameMatch: true });
        expect(calls.embedded).toEqual(["prisma"]);
      }),
    );

    test.effect("fails with AiOutputInvalid when the query vector does not fit the database column", () =>
      Effect.gen(function* () {
        const scope = yield* seed(909, orms(9900));
        const narrow = Fake.layerEmbeddings({ ...Fake.hashEmbeddingModel, dimensions: 512 });
        const service = yield* Search.make.pipe(Effect.provide(narrow));
        const error = yield* service.search({ scope, query: "zebra-vector-check", limit: 10 }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AiOutputInvalid", operation: "embed", model });
      }),
    );
  };

  return { layerSearch, searchCases };
};

for (const [label, database] of [
  ["PGlite search", TestDatabase.layerMemory({ embeddingModel: model })],
  ["node-postgres search", TestDatabase.layerNodePostgres({ embeddingModel: model })],
] as const) {
  const { layerSearch, searchCases } = fixture();
  it.layer(layerSearch(database), { timeout: 30_000 })(label, searchCases);
}
