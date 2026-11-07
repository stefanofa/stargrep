import { expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import { Embedding, EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import * as ModelAllowance from "./model-allowance.ts";
import * as QueryPlan from "./query-plan.ts";
import * as QueryPlanner from "./query-planner.ts";
import * as Search from "./search.ts";
import * as SearchCache from "./search-cache.ts";

const model = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const calls = { prompts: 0, embedded: 0 };

const layerEmbeddings = Layer.effect(
  Embeddings.Embeddings,
  Effect.map(Effect.service(Embeddings.Embeddings), (inner) =>
    Embeddings.Embeddings.of({
      model: inner.model,
      embed: (values) => Effect.sync(() => (calls.embedded += values.length)).pipe(Effect.andThen(inner.embed(values))),
    }),
  ),
).pipe(Layer.provide(Fake.layerEmbeddings()));

const ormPlan = Schema.encodeSync(QueryPlan.PlannerOutput)({
  semanticText: "rust orm for sql databases",
  filters: QueryPlan.noFilters,
  ranking: { _tag: "relevance" },
});

const planner = Fake.layerTextGeneration(() => {
  calls.prompts++;
  return ormPlan;
}, "fake/planner");

const network = (name: string) => Db.CallerKey.make(name);

const take = (caller: string, call: ModelAllowance.ModelCall) =>
  ModelAllowance.ModelAllowance.use((allowance) => allowance.take(call)).pipe(
    Effect.provide(ModelAllowance.layerMetered(network(caller))),
  );

const allowed = (caller: string, call: ModelAllowance.ModelCall) =>
  Effect.map(Effect.result(take(caller, call)), Result.isSuccess);

const takeAll = (caller: string, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => allowed(caller, "plan"));

const searchAs = (caller: string, query: string) =>
  Search.Search.use((search) =>
    search.search({ scope: { _tag: "stars", login: Login.make("user-77") }, query, limit: 10 }),
  ).pipe(
    Effect.provide(
      Search.layer.pipe(
        Layer.provideMerge(QueryPlanner.layer),
        Layer.provide(ModelAllowance.layerMetered(network(caller))),
        Layer.provide(planner),
      ),
    ),
  );

const clearLines = TestDatabase.TestDatabase.use((database) => database.query("delete from rate_lines"));

const refusals = (call: ModelAllowance.ModelCall, reason: ModelAllowance.ModelCallRefused["reason"]) =>
  Effect.map(
    Metric.value(Metric.withAttributes(ModelAllowance.callsRefused, { call, reason })),
    (state) => state.count,
  );

const seeded = Effect.gen(function* () {
  const db = yield* Db.Db;
  const embeddings = yield* Embeddings.Embeddings;
  const accountId = GitHubAccountId.make(77);
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login: Login.make("user-77"),
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  const repos = [
    { id: 7701, name: "diesel", summary: "rust orm for sql databases" },
    { id: 7702, name: "ratatui", summary: "rust library for terminal dashboards" },
  ];
  for (const repo of repos) {
    const ref = {
      id: RepoId.make(repo.id),
      nodeId: RepoNodeId.make(`R_${repo.id}`),
      owner: Login.make("owner"),
      name: RepoName.make(repo.name),
    };
    yield* db.repos.upsertRefs([ref]);
    yield* db.repos.saveSummary({ id: ref.id, readmeOid: null, summary: repo.summary, keywords: [], kind: "library" });
    const [vector] = yield* embeddings.embed([repo.summary]);
    yield* db.repos.saveEmbedding({
      owner: ref.owner,
      name: ref.name,
      keywords: [],
      description: null,
      id: ref.id,
      embedding: yield* decodeEmbedding({ model, vector: vector?.vector }),
      summary: repo.summary,
      readmeOid: null,
    });
  }
  yield* db.stars.upsert({
    accountId,
    stars: repos.map((repo) => ({
      repoId: RepoId.make(repo.id),
      starredAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      source: "api" as const,
    })),
  });
  calls.prompts = 0;
  calls.embedded = 0;
});

type Services = Db.Db | TestDatabase.TestDatabase | Embeddings.Embeddings | SearchCache.SearchCache;

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("refuses the 31st model call from one network in a minute, and lets another network through", () =>
    Effect.gen(function* () {
      yield* clearLines;
      expect(yield* takeAll("network-a", 30)).toEqual(Array(30).fill(true));
      const refused = yield* Effect.flip(take("network-a", "embed"));
      expect(refused).toMatchObject({ _tag: "ModelCallRefused", call: "embed", reason: "network" });
      expect(yield* allowed("network-b", "plan")).toBe(true);
    }),
  );

  test.effect("lets a network make one more call every 2 seconds after its burst", () =>
    Effect.gen(function* () {
      yield* clearLines;
      yield* takeAll("network-c", 30);
      expect(yield* allowed("network-c", "plan")).toBe(false);
      yield* TestClock.adjust("1999 millis");
      expect(yield* allowed("network-c", "plan")).toBe(false);
      yield* TestClock.adjust("1 millis");
      expect([yield* allowed("network-c", "plan"), yield* allowed("network-c", "plan")]).toEqual([true, false]);
    }),
  );

  test.effect("refuses every network once all of them together made 600 calls, the hour's burst", () =>
    Effect.gen(function* () {
      yield* clearLines;
      for (let index = 0; index < 20; index++) {
        expect(yield* takeAll(`network-${index}`, 30)).toEqual(Array(30).fill(true));
      }
      const refused = yield* Effect.flip(take("network-20", "plan"));
      expect(refused).toMatchObject({ _tag: "ModelCallRefused", call: "plan", reason: "all" });
      yield* TestClock.adjust(Duration.millis(600));
      expect(yield* allowed("network-21", "plan")).toBe(true);
    }),
  );

  test.effect("spends nothing from everyone's line on a call its own network's line refuses", () =>
    Effect.gen(function* () {
      yield* clearLines;
      yield* takeAll("network-d", 35);
      const now = yield* DateTime.now;
      const busy = yield* Db.Db.use((db) => db.rateLines.wait(RateLine.modelAll.key, now, Duration.zero));
      expect(busy).toEqual(Duration.seconds(18));
    }),
  );

  test.effect("counts refusals by call and by the line that refused, and never by network", () =>
    Effect.gen(function* () {
      yield* clearLines;
      const before = yield* refusals("embed", "network");
      yield* takeAll("network-e", 30);
      yield* Effect.flip(take("network-e", "embed"));
      expect((yield* refusals("embed", "network")) - before).toBe(1);
      const refused = (yield* Metric.snapshot).filter((metric) => metric.id === "stargrep_model_calls_refused");
      expect(refused.map((metric) => Object.keys(metric.attributes ?? {}).sort())).toEqual(
        refused.map(() => ["call", "reason"]),
      );
    }),
  );

  test.effect("answers with the typed words on full text alone once the network's calls run out", () =>
    Effect.gen(function* () {
      yield* clearLines;
      yield* seeded;
      yield* takeAll("network-f", 30);
      for (const query of ["a rust orm for sql databases", "diesel orm"]) {
        const outcome = yield* searchAs("network-f", query);
        expect(outcome).toMatchObject({
          planSource: "fallback",
          plan: QueryPlan.asTyped(query, QueryPlan.queryKind(query)),
        });
        expect(outcome.results.map((result): string => result.repo.name)).toContain("diesel");
        expect(outcome.results.every((result) => result.vectorRank === null)).toBe(true);
      }
      expect(calls).toEqual({ prompts: 0, embedded: 0 });
    }),
  );

  test.effect("takes nothing for a plan or a query embedding the cache already holds", () =>
    Effect.gen(function* () {
      yield* clearLines;
      yield* seeded;
      const first = yield* searchAs("network-g", "which rust orm should i use");
      expect([first.planSource, calls]).toEqual(["model", { prompts: 1, embedded: 1 }]);
      const again = yield* searchAs("network-g", "which rust orm should i use");
      expect([again.planSource, calls]).toEqual(["cache", { prompts: 1, embedded: 1 }]);
      expect(yield* takeAll("network-g", 29)).toEqual([...Array(28).fill(true), false]);
    }),
  );
};

const layerTest = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
  Layer.mergeAll(SearchCache.layerMemory, layerEmbeddings, database);

it.layer(layerTest(TestDatabase.layerMemory({ embeddingModel: model })), { timeout: 60_000 })(
  "PGlite model allowance",
  cases,
);
it.layer(layerTest(TestDatabase.layerNodePostgres({ embeddingModel: model })), { timeout: 60_000 })(
  "node-postgres model allowance",
  (test) => {
    cases(test);

    test.effect("allows exactly 30 of 45 calls one network makes at once", () =>
      Effect.gen(function* () {
        yield* clearLines;
        const answers = yield* Effect.all(
          Array.from({ length: 45 }, () => allowed("network-h", "embed")),
          { concurrency: "unbounded" },
        );
        expect(answers.filter(Boolean)).toHaveLength(30);
      }),
    );

    test.effect("allows exactly 600 of 630 calls 21 networks make at once", () =>
      Effect.gen(function* () {
        yield* clearLines;
        const answers = yield* Effect.all(
          Array.from({ length: 630 }, (_, index) => allowed(`network-burst-${index % 21}`, "plan")),
          { concurrency: 50 },
        );
        expect(answers.filter(Boolean)).toHaveLength(600);
      }),
    );
  },
);
