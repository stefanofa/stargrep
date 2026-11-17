import { expect } from "bun:test";
import type * as Embeddings from "@stargrep/ai/embeddings";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import * as TestDatabase from "@stargrep/db/test-database";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import { embeddingModel, fixture, id, oid } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as SummaryAllowance from "./summary-allowance.ts";

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

// The summary line pays out one unit every 86.4 seconds once a day's units are spent.
const unit = Duration.millis(86_400);

for (const [adapter, database] of adapters) {
  const f = fixture();
  let calls = 0;
  const text = f.textGeneration((request) =>
    Effect.sync(() => {
      calls++;
      return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
    }),
  );
  const embedded: Array<string> = [];
  const recording = f.embeddingsWith((values) =>
    Effect.sync(() => {
      embedded.push(...values);
      return f.vectors(values);
    }),
  );
  // The Worker's enrichment: the summary cap metered in the database's rate lines.
  const metered = (ids: ReadonlyArray<RepoId>, embeddings: Layer.Layer<Embeddings.Embeddings> = recording) =>
    EnrichRepo.EnrichRepo.use((enricher) => enricher.enrichRepos(ids)).pipe(
      Effect.map((outcomes) => outcomes.map((outcome) => outcome._tag)),
      Effect.provide(
        Layer.fresh(EnrichRepo.layer).pipe(
          Layer.provide(Layer.mergeAll(text, embeddings, SummaryAllowance.layerMetered)),
        ),
      ),
    );
  const spend = Effect.fn("test.spend")(function* (line: RateLine.Line, units: number) {
    const db = yield* Db.Db;
    const reserved = yield* RateLine.reserve(db.rateLines, line, yield* DateTime.now, units);
    expect(Option.isSome(reserved)).toBe(true);
  });
  const seed = (n: number, description: string | null = `Repo ${n}`, topics?: ReadonlyArray<string>) => {
    f.remotes.set(n, {
      description,
      ...(topics === undefined ? {} : { topics }),
      readme: { oid: oid("c"), text: "# Repo" },
    });
    return Effect.map(f.store([n]), () => id(n));
  };
  const stateOf = (n: number) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) =>
      test.query(
        `select embedding is not null as embedded, embedding_source as source, embedding_stale as stale,
          summary is not null as summarized, summary_deferred as deferred, enrich_failures as failures
        from repos where id = $1`,
        [n],
      ),
    );
  const warnings: Array<unknown> = [];
  const logger = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push((message as ReadonlyArray<unknown>)[0]);
    }),
  ]);

  it.layer(f.enrichment(database), { timeout: 30_000 })(`metadata embeddings on ${adapter}`, (it) => {
    it.effect("embeds a capped repo's metadata once, again when it changes, and lets the summary replace it", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-05T00:00:00Z"));
        yield* spend(RateLine.summaryAll, RateLine.summariesPerDay);
        const repoId = yield* seed(2101);
        calls = 0;
        embedded.length = 0;

        expect(yield* metered([repoId])).toEqual(["Capped"]);
        expect(calls).toBe(0);
        expect(embedded).toEqual(["owner/repo-2101\nRepo 2101\ncli"]);
        expect(yield* stateOf(2101)).toEqual([
          { embedded: true, source: "metadata", stale: false, summarized: false, deferred: true, failures: 0 },
        ]);

        yield* TestClock.adjust(unit);
        yield* spend(RateLine.summaryAll, 1);
        expect(yield* metered([repoId])).toEqual(["Capped"]);
        expect(embedded).toHaveLength(1);

        f.remotes.set(2101, { description: "A terminal image viewer", readme: { oid: oid("c"), text: "# Repo" } });
        yield* TestClock.adjust(unit);
        yield* spend(RateLine.summaryAll, 1);
        expect(yield* metered([repoId])).toEqual(["Capped"]);
        expect(embedded.at(-1)).toBe("owner/repo-2101\nA terminal image viewer\ncli");
        expect(yield* stateOf(2101)).toMatchObject([{ source: "metadata", stale: false, deferred: true }]);

        yield* TestClock.adjust(unit);
        expect(yield* metered([repoId])).toEqual(["Summarized"]);
        expect(calls).toBe(1);
        expect(yield* stateOf(2101)).toEqual([
          { embedded: true, source: "summary", stale: false, summarized: true, deferred: false, failures: 0 },
        ]);
      }),
    );

    it.effect("keeps the metadata embedding, marked stale, while a saved summary waits for its own", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-12-05T00:00:00Z"));
        yield* spend(RateLine.summaryAll, RateLine.summariesPerDay);
        const repoId = yield* seed(2201);
        expect(yield* metered([repoId])).toEqual(["Capped"]);

        yield* TestClock.adjust(unit);
        expect(yield* metered([repoId], f.failingEmbeddings)).toEqual(["Failed"]);
        expect(yield* stateOf(2201)).toEqual([
          { embedded: true, source: "metadata", stale: true, summarized: true, deferred: true, failures: 0 },
        ]);
        const db = yield* Db.Db;
        expect(yield* db.repos.pendingEnrichment([repoId])).toEqual([repoId]);

        embedded.length = 0;
        calls = 0;
        expect(yield* metered([repoId])).toEqual(["Embedded"]);
        expect(calls).toBe(0);
        expect(embedded).toHaveLength(1);
        expect(embedded[0]).not.toBe("owner/repo-2201\nRepo 2201\ncli");
        expect(yield* stateOf(2201)).toMatchObject([{ source: "summary", stale: false, deferred: false }]);
      }),
    );

    it.effect("leaves a capped repo's summary embedding, and a repo with only a name, unembedded by metadata", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2027-01-05T00:00:00Z"));
        const summarized = yield* seed(2301);
        expect(yield* metered([summarized])).toEqual(["Summarized"]);
        yield* Effect.flatMap(TestDatabase.TestDatabase, (test) =>
          test.query("update repos set summary_recipe = summary_recipe - 1 where id = $1", [2301]),
        );
        const nameOnly = yield* seed(2302, null, []);
        yield* spend(RateLine.summaryAll, RateLine.summariesPerDay);
        embedded.length = 0;

        expect(yield* metered([summarized, nameOnly])).toEqual(["Capped", "Capped"]);
        expect(embedded).toEqual([]);
        expect(yield* stateOf(2301)).toMatchObject([{ embedded: true, source: "summary", stale: false }]);
        expect(yield* stateOf(2302)).toMatchObject([{ embedded: false, deferred: true }]);
      }),
    );

    it.effect("takes nothing from the summary cap, and waits when its own line or the model refuses", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2027-02-05T00:00:00Z"));
        yield* spend(RateLine.summaryAll, RateLine.summariesPerDay);
        const failing = yield* seed(2401);
        const refused = yield* seed(2402);
        embedded.length = 0;
        warnings.length = 0;

        expect(yield* metered([failing], f.failingEmbeddings).pipe(Effect.provide(logger))).toEqual(["Capped"]);
        expect(yield* stateOf(2401)).toMatchObject([{ embedded: false, deferred: true, failures: 0 }]);
        expect(warnings).toContain("Metadata embedding failed");

        yield* spend(RateLine.metadataAll, RateLine.metadataEmbeddingsPerDay);
        expect(yield* metered([refused]).pipe(Effect.provide(logger))).toEqual(["Capped"]);
        expect(embedded).toEqual([]);
        expect(yield* stateOf(2402)).toMatchObject([{ embedded: false, deferred: true }]);
        expect(warnings).toContain("Metadata embedding line reached, 1 repos waiting");

        yield* TestClock.adjust(Duration.days(1));
        expect(yield* metered([failing, refused])).toEqual(["Summarized", "Summarized"]);
      }),
    );
  });
}
