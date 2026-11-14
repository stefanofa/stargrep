import { expect } from "bun:test";
import type * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import { Login } from "@stargrep/github/schemas";
import { everything, type Selection, SelectionKey } from "@stargrep/knowledge/atom";
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
import { recordingEmbeddings, seedLibrary } from "./search.fixture.ts";
import * as Search from "./search.ts";
import * as SearchCache from "./search-cache.ts";

const model = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");

const fixture = () => {
  const calls = { prompts: 0, embedded: 0 };

  const layerEmbeddings = recordingEmbeddings((values) => {
    calls.embedded += values.length;
  });

  const ormPlan = Schema.encodeSync(QueryPlan.PlannerOutput)({
    semanticText: "rust orm for sql databases",
    filters: QueryPlan.noFilters,
    ranking: { _tag: "relevance" },
  });

  const rustQuery = "an orm in rust for sql databases";

  const rustOutput: QueryPlan.PlannerOutput = {
    semanticText: "an object relational mapper written in rust",
    filters: { ...QueryPlan.noFilters, languages: [{ language: "Rust", said: "rust" }] },
    ranking: { _tag: "relevance" },
  };

  const rustPlan = Schema.encodeSync(QueryPlan.PlannerOutput)(rustOutput);

  const planner = Fake.layerTextGeneration((prompt) => {
    calls.prompts++;
    return prompt.endsWith(`Query: ${rustQuery}`) ? rustPlan : ormPlan;
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

  const searchAs = (
    caller: string,
    query: string,
    filter: Selection = everything,
    allowance: Layer.Layer<ModelAllowance.ModelAllowance, never, Db.Db> = ModelAllowance.layerMetered(network(caller)),
  ) =>
    Search.Search.use((search) =>
      search.search({ scope: { _tag: "stars", login: Login.make("user-77") }, query, limit: 10, filter }),
    ).pipe(
      Effect.provide(
        Search.layer.pipe(Layer.provideMerge(QueryPlanner.layer), Layer.provide(allowance), Layer.provide(planner)),
      ),
    );

  const unreadableMeter = Layer.effect(
    Db.Db,
    Db.Db.use((db) =>
      Effect.succeed({
        ...db,
        rateLines: {
          ...db.rateLines,
          reserve: () =>
            Effect.fail(new DbQueryFailed({ operation: "rateLines.reserve", reason: "transport", sqlState: null })),
        },
      }),
    ),
  );

  const clearLines = TestDatabase.TestDatabase.use((database) => database.query("delete from rate_lines"));

  const refusals = (call: ModelAllowance.ModelCall, reason: ModelAllowance.ModelCallRefused["reason"]) =>
    Effect.map(
      Metric.value(Metric.withAttributes(ModelAllowance.callsRefused, { call, reason })),
      (state) => state.count,
    );

  const seeded = seedLibrary(77, [
    {
      id: 7701,
      name: "diesel",
      summary: "rust orm for sql databases",
      language: "Rust",
      starredAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 7702,
      name: "ratatui",
      summary: "rust library for terminal dashboards",
      language: "Rust",
      starredAt: "2026-01-01T00:00:00Z",
    },
  ]).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        calls.prompts = 0;
        calls.embedded = 0;
      }),
    ),
  );

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

    test.effect("admits the 600th global call, refuses the next network, and reopens after 600ms", () =>
      Effect.gen(function* () {
        yield* clearLines;
        const db = yield* Db.Db;
        yield* RateLine.bill(db.rateLines, RateLine.modelAll, yield* DateTime.now, 599);
        expect(yield* allowed("network-19", "plan")).toBe(true);
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

    test.effect("keeps a plan the model made, on full text alone, when the query embedding after it is refused", () =>
      Effect.gen(function* () {
        yield* clearLines;
        yield* seeded;
        yield* takeAll("network-j", 29);
        const outcome = yield* searchAs("network-j", rustQuery);
        expect(outcome).toMatchObject({
          planSource: "fallback",
          plan: QueryPlan.fromPlannerOutput(rustQuery, rustOutput),
        });
        expect(outcome.applied.map(({ atom, mode }) => `${mode} ${atom}`)).toContain("filter lang:rust");
        expect(outcome.results.map((result): string => result.repo.name)).toEqual(["diesel"]);
        expect(outcome.results.every((result) => result.vectorRank === null)).toBe(true);
        expect(calls).toEqual({ prompts: 1, embedded: 0 });
      }),
    );

    test.effect("refuses every model call as meter-down when the lines cannot be read, and still answers", () =>
      Effect.gen(function* () {
        yield* seeded;
        const before = [yield* refusals("plan", "meter-down"), yield* refusals("embed", "meter-down")];
        const query = "a rust orm for sql databases";
        const unreadable = ModelAllowance.layerMetered(network("network-k")).pipe(Layer.provide(unreadableMeter));
        const outcome = yield* searchAs("network-k", query, everything, unreadable);
        expect(outcome).toMatchObject({ planSource: "fallback", plan: QueryPlan.asTyped(query, "sentence") });
        expect(outcome.results.map((result): string => result.repo.name)).toEqual(["diesel"]);
        expect(calls).toEqual({ prompts: 0, embedded: 0 });
        const after = [yield* refusals("plan", "meter-down"), yield* refusals("embed", "meter-down")];
        expect(after.map((count, index) => count - (before[index] ?? 0))).toEqual([1, 1]);
      }),
    );

    test.effect("keeps the caller's filter when the network's calls run out", () =>
      Effect.gen(function* () {
        yield* clearLines;
        yield* seeded;
        yield* takeAll("network-i", 30);
        const query = "a rust orm for sql databases";
        const names = (filter: string) =>
          searchAs("network-i", query, Schema.decodeSync(SelectionKey)(filter)).pipe(
            Effect.map((outcome) => ({
              source: outcome.planSource,
              names: outcome.results.map((result): string => result.repo.name),
              applied: outcome.applied.map(({ atom, mode, from }) => `${from} ${mode} ${atom}`),
            })),
          );
        expect(yield* names("kind:cli")).toEqual({
          source: "fallback",
          names: [],
          applied: ["filter filter kind:cli"],
        });
        expect(yield* names("-lang:rust")).toEqual({
          source: "fallback",
          names: [],
          applied: ["filter exclude lang:rust"],
        });
        expect((yield* names("kind:library")).names).toContain("diesel");
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

  return { layerTest, cases, clearLines, allowed };
};

{
  const f = fixture();

  it.layer(f.layerTest(TestDatabase.layerMemory({ embeddingModel: model })), { timeout: 60_000 })(
    "PGlite model allowance",
    f.cases,
  );
}

{
  const f = fixture();

  it.layer(f.layerTest(TestDatabase.layerNodePostgres({ embeddingModel: model })), { timeout: 60_000 })(
    "node-postgres model allowance",
    (test) => {
      f.cases(test);

      test.effect("allows exactly 30 of 45 calls one network makes at once", () =>
        Effect.gen(function* () {
          yield* f.clearLines;
          const answers = yield* Effect.all(
            Array.from({ length: 45 }, () => f.allowed("network-h", "embed")),
            { concurrency: "unbounded" },
          );
          expect(answers.filter(Boolean)).toHaveLength(30);
        }),
      );

      test.effect("allows exactly the remaining 30 global calls when 21 networks race for them", () =>
        Effect.gen(function* () {
          yield* f.clearLines;
          const db = yield* Db.Db;
          yield* RateLine.bill(db.rateLines, RateLine.modelAll, yield* DateTime.now, 570);
          const answers = yield* Effect.all(
            Array.from({ length: 63 }, (_, index) => f.allowed(`network-burst-${index % 21}`, "plan")),
            { concurrency: 50 },
          );
          expect(answers.filter(Boolean)).toHaveLength(30);
        }),
      );
    },
  );
}
