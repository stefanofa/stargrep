import { expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import { Embedding, EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { registry } from "./metric-registry.ts";
import * as QueryPlan from "./query-plan.ts";
import * as QueryPlanner from "./query-planner.ts";
import * as Search from "./search.ts";
import * as SearchCache from "./search-cache.ts";

const model = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const calls = { prompts: [] as Array<string>, embedded: [] as Array<string> };
let respond: (prompt: string) => unknown = () => ({});

const layerEmbeddings = Layer.effect(
  Embeddings.Embeddings,
  Effect.map(Effect.service(Embeddings.Embeddings), (inner) =>
    Embeddings.Embeddings.of({
      model: inner.model,
      embed: (values) => Effect.sync(() => calls.embedded.push(...values)).pipe(Effect.andThen(inner.embed(values))),
    }),
  ),
).pipe(Layer.provide(Fake.layerEmbeddings()));

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
    Layer.provideMerge(SearchCache.layerMemory),
    Layer.provideMerge(layerEmbeddings),
    Layer.provideMerge(db),
  );

interface Seed {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
  readonly language: string;
  readonly starredAt: string;
  readonly stars?: number;
  readonly kind?: string;
  readonly license?: string;
}

const seed = Effect.fn("seed")(function* (account: number, repos: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  const embeddings = yield* Embeddings.Embeddings;
  const accountId = GitHubAccountId.make(account);
  const login = Login.make(`user-${account}`);
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login,
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  for (const repo of repos) {
    const id = RepoId.make(repo.id);
    const ref = {
      id,
      nodeId: RepoNodeId.make(`R_${repo.id}`),
      owner: Login.make("owner"),
      name: RepoName.make(repo.name),
    };
    yield* db.repos.upsertRefs([ref]);
    yield* db.repos.saveFacts({
      ...ref,
      description: null,
      topics: [],
      language: repo.language,
      license: repo.license ?? null,
      homepage: null,
      createdAt: null,
      pushedAt: null,
      archived: false,
      readmeOid: null,
      ownerType: null,
      ownerAvatarUrl: null,
    });
    yield* db.repos.saveSummary({
      id,
      readmeOid: null,
      summary: repo.summary,
      keywords: [],
      kind: repo.kind ?? "library",
    });
    const [vector] = yield* embeddings.embed([repo.summary]);
    yield* db.repos.saveEmbedding({
      id,
      embedding: yield* decodeEmbedding({ model, vector: vector?.vector }),
      summary: repo.summary,
      readmeOid: null,
    });
    if (repo.stars !== undefined) {
      yield* database.query(
        "insert into repo_metrics (repo_id, stars, stars_90d, refreshed_at) values ($1, $2, $3, now())",
        [repo.id, repo.stars, repo.stars / 10],
      );
    }
  }
  yield* db.stars.upsert({
    accountId,
    stars: repos.map((repo) => ({
      repoId: RepoId.make(repo.id),
      starredAt: DateTime.makeUnsafe(repo.starredAt),
      observedAt: DateTime.makeUnsafe(repo.starredAt),
      source: "api" as const,
    })),
  });
  calls.prompts.length = 0;
  calls.embedded.length = 0;
  return { _tag: "stars", login } satisfies Search.Scope;
});

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
        const hits = yield* db.search.hybrid({
          scope: { kind: "stars", accountId: GitHubAccountId.make(907) },
          text: "orm",
          embedding,
          maxDistance: 2,
          limit: 10,
          name: null,
          metrics: [metric],
          filters: { ...Db.noFilters, metrics: [{ metric: metric.id, op: "gt", value: -1e12 }] },
          rankBy: { metric: metric.id, direction: "highest" },
        });
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
      const narrow = Fake.layerEmbeddings({ id: model, dimensions: 512 });
      const service = yield* Search.make.pipe(Effect.provide(narrow));
      const error = yield* service.search({ scope, query: "zebra-vector-check", limit: 10 }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "AiOutputInvalid", operation: "embed", model });
    }),
  );
};

it.layer(layerSearch(TestDatabase.layerMemory({ embeddingModel: model })), { timeout: 30_000 })(
  "PGlite search",
  searchCases,
);
it.layer(layerSearch(TestDatabase.layerNodePostgres({ embeddingModel: model })))("node-postgres search", searchCases);
