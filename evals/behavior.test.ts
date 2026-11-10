import { expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Models from "@stargrep/ai/models";
import { Compile, ModelAllowance, QueryPlan, QueryPlanner, Search, SearchCache } from "@stargrep/core/search";
import * as TestDatabase from "@stargrep/db/test-database";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { acceptFloor, embeddingModelId, loadAccount, scope } from "./account.ts";
import { type Judged, judged } from "./behavior.ts";
import { EnrichedRepo } from "./enriched-corpus.ts";

const decodeRepo = Schema.decodeSync(Schema.fromJsonString(EnrichedRepo));
const repos = (await Bun.file(new URL("./fixtures/behavior-repos.jsonl", import.meta.url)).text())
  .split("\n")
  .filter(Boolean)
  .map((line) => decodeRepo(line));

const caseFor = (text: string): Judged | undefined =>
  judged.find((entry) => text === entry.query || text.endsWith(`Query: ${entry.query}`));

const encodePlan = Schema.encodeSync(QueryPlan.PlannerOutput);

// The plan a guarded planner would give each judged query, with the query as its semantic text.
const planner = Fake.layerTextGeneration((prompt) => {
  const entry = caseFor(prompt);
  return encodePlan({
    semanticText: entry?.query ?? "nothing judged",
    filters: {
      ...QueryPlan.noFilters,
      languages: (entry?.languages ?? []).map((language) => ({ language, said: language.toLowerCase() })),
      kinds: entry?.kinds ?? [],
    },
    ranking: { _tag: "relevance" },
  });
}, Models.plannerModel);

// The recorded vector of each case's stand-in repo, for its semantic text.
const embeddings = Layer.succeed(
  Embeddings.Embeddings,
  Embeddings.make({
    provider: "fixture",
    model: Models.embeddingModel,
    timeout: Duration.seconds(1),
    run: (values) =>
      Effect.succeed({
        vectors: values.map((value) => repos.find((repo) => repo.fullName === caseFor(value)?.near)?.vector ?? []),
        tokens: 0,
      }),
  }),
);

// Every row null compiles no atoms, which is the search to compare against.
const noAtoms = Object.fromEntries(Object.keys(Compile.policy).map((row) => [row, [null, null]])) as never;

const names = (outcome: Search.SearchOutcome) => outcome.results.map(({ repo }) => `${repo.owner}/${repo.name}`);

// Nothing accepted, as in prod today, or what the usage floor accepts.
const modes = [
  { name: "no subject accepted", floor: false },
  { name: "the usage floor's subjects accepted", floor: true },
] as const;

const layer = (mode: (typeof modes)[number]) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* loadAccount(repos);
      if (mode.floor) yield* acceptFloor();
    }),
  ).pipe(
    Layer.provideMerge(Search.layer),
    Layer.provideMerge(QueryPlanner.layer.pipe(Layer.provide(planner))),
    Layer.provideMerge(SearchCache.layerMemory),
    Layer.provideMerge(ModelAllowance.layerUnmetered),
    Layer.provideMerge(embeddings),
    Layer.provideMerge(TestDatabase.layerMemory({ embeddingModel: embeddingModelId })),
  );

for (const mode of modes) {
  it.layer(layer(mode), { timeout: 120_000, testTimeout: 30_000 })(`judged queries with ${mode.name}`, (test) => {
    for (const entry of judged) {
      test.effect(entry.query, () =>
        Effect.gen(function* () {
          const search = yield* Search.Search;
          const request = { scope, query: entry.query, limit: 50 };
          const before = names(
            yield* search.search(request).pipe(Effect.provideService(Compile.CurrentPolicy, noAtoms)),
          );
          const after = names(yield* search.search(request));
          const drops = [...(entry.drops ?? []), ...(mode.floor ? (entry.dropsOnceAccepted ?? []) : [])];
          expect(before).toEqual(expect.arrayContaining([...entry.keeps, ...drops]));
          expect(after).toEqual(expect.arrayContaining([...entry.keeps]));
          expect(after.filter((name) => drops.includes(name))).toEqual([]);
          // What the words imply never empties a search that finds more than a handful without them.
          if (before.length > 5) expect(after.length).toBeGreaterThan(0);
        }),
      );
    }
  });
}
