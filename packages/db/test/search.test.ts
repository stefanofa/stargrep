import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, at, embedding, facts, hybrid, model, ref, repoId, starred, stars } from "./fixtures.ts";

interface Seed {
  readonly id: RepoId;
  readonly name?: string;
  readonly summary?: string;
  readonly kind?: string;
  readonly language?: string;
  readonly license?: string;
  readonly topics?: ReadonlyArray<string>;
  readonly archived?: boolean;
  readonly starredAt?: string;
  readonly weights?: Readonly<Record<number, number>>;
  readonly metrics?: { readonly stars: number; readonly stars90d: number };
}

const seed = Effect.fn("seed")(function* (owner: GitHubAccountId, repos: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  yield* db.accounts.upsert(account(owner));
  yield* db.repos.upsertRefs(repos.map((repo) => ref(repo.id, repo.name)));
  for (const repo of repos) {
    yield* db.repos.saveFacts({
      ...facts(repo.id),
      ...(repo.name === undefined ? {} : { name: ref(repo.id, repo.name).name }),
      language: repo.language ?? null,
      topics: repo.topics ?? [],
      license: repo.license ?? null,
      archived: repo.archived ?? false,
    });
    yield* db.repos.saveSummary({
      id: repo.id,
      readmeOid: null,
      summary: repo.summary ?? "unrelated project",
      keywords: [],
      kind: repo.kind ?? "app",
    });
    yield* db.repos.saveEmbedding({
      id: repo.id,
      embedding: embedding(repo.weights ?? { 5: 1 }),
      summary: repo.summary ?? "unrelated project",
      readmeOid: null,
    });
    if (repo.metrics !== undefined) {
      yield* database.query(
        "insert into repo_metrics (repo_id, stars, stars_90d, refreshed_at) values ($1, $2, $3, now())",
        [repo.id, repo.metrics.stars, repo.metrics.stars90d],
      );
    }
  }
  yield* db.stars.upsert({
    accountId: owner,
    stars: repos.map((repo) => starred(repo.id, repo.starredAt ?? "2026-01-01T00:00:00Z")),
  });
});

const starsMetric: Db.SearchMetric = { id: "stars", family: "stars", variant: "total" };
const growthMetric: Db.SearchMetric = { id: "stars_growth_90d", family: "stars", variant: "growth_90d" };

const searchCases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("keeps only the stars that match every filter", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(801);
      const [match, otherLanguage, otherKind, otherLicense, archived, tooEarly, tooLate] = [
        repoId(8001),
        repoId(8002),
        repoId(8003),
        repoId(8004),
        repoId(8005),
        repoId(8006),
        repoId(8007),
      ];
      const base = { language: "TypeScript", kind: "library", license: "MIT", starredAt: "2025-06-01T00:00:00Z" };
      yield* seed(owner, [
        { id: match, ...base },
        { id: otherLanguage, ...base, language: "Rust" },
        { id: otherKind, ...base, kind: "app" },
        { id: otherLicense, ...base, license: "GPL-3.0" },
        { id: archived, ...base, archived: true },
        { id: tooEarly, ...base, starredAt: "2024-12-31T23:59:59Z" },
        { id: tooLate, ...base, starredAt: "2026-01-01T00:00:00Z" },
      ]);

      const query = { scope: stars(owner), text: "", embedding: embedding({ 5: 1 }), limit: 10 };
      const hits = yield* db.search.hybrid(
        hybrid({
          ...query,
          filters: {
            ...Db.noFilters,
            languages: ["typescript"],
            kinds: ["library"],
            licenses: ["mit"],
            archived: false,
            starredAfter: at("2025-01-01T00:00:00Z"),
            starredBefore: at("2026-01-01T00:00:00Z"),
          },
        }),
      );
      expect(hits.map((hit) => hit.repo.id)).toEqual([match]);

      const archivedOnly = yield* db.search.hybrid(hybrid({ ...query, filters: { ...Db.noFilters, archived: true } }));
      expect(archivedOnly.map((hit) => hit.repo.id)).toEqual([archived]);
    }),
  );

  test.effect("returns metric values and keeps only repos inside the metric bounds", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(802);
      const [big, growing, small, unmeasured] = [repoId(8101), repoId(8102), repoId(8103), repoId(8104)];
      yield* seed(owner, [
        { id: big, metrics: { stars: 50_000, stars90d: 500 } },
        { id: growing, metrics: { stars: 2_000, stars90d: 1_000 } },
        { id: small, metrics: { stars: 40, stars90d: 0 } },
        { id: unmeasured },
      ]);

      const query = {
        scope: stars(owner),
        text: "",
        embedding: embedding({ 5: 1 }),
        limit: 10,
        metrics: [starsMetric, growthMetric],
      };
      const bounded = yield* db.search.hybrid(
        hybrid({
          ...query,
          filters: {
            ...Db.noFilters,
            metrics: [
              { metric: "stars", op: "gte", value: 1_000 },
              { metric: "stars_growth_90d", op: "lte", value: 0.5 },
            ],
          },
        }),
      );
      expect(bounded.map((hit) => [hit.repo.id, hit.metrics])).toEqual([[big, [50_000, 500 / 49_500]]]);

      const ranked = yield* db.search.hybrid(hybrid({ ...query, rankBy: { metric: "stars", direction: "highest" } }));
      expect(ranked.map((hit) => [hit.repo.id, hit.metrics[0]])).toEqual([
        [big, 50_000],
        [growing, 2_000],
        [small, 40],
        [unmeasured, null],
      ]);
    }),
  );

  test.effect("keeps a strict bound strict and an inclusive bound inclusive", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(807);
      const [exactly, above, below] = [repoId(8601), repoId(8602), repoId(8603)];
      yield* seed(owner, [
        { id: exactly, metrics: { stars: 200, stars90d: 0 } },
        { id: above, metrics: { stars: 300, stars90d: 0 } },
        { id: below, metrics: { stars: 100, stars90d: 0 } },
      ]);
      const bounded = (op: Db.MetricBound["op"]) =>
        db.search
          .hybrid(
            hybrid({
              scope: stars(owner),
              text: "",
              embedding: embedding({ 5: 1 }),
              limit: 10,
              metrics: [starsMetric],
              filters: { ...Db.noFilters, metrics: [{ metric: "stars", op, value: 200 }] },
            }),
          )
          .pipe(Effect.map((hits) => hits.map((hit) => hit.metrics[0]).sort()));
      expect(yield* bounded("gt")).toEqual([300]);
      expect(yield* bounded("gte")).toEqual([200, 300]);
      expect(yield* bounded("lt")).toEqual([100]);
      expect(yield* bounded("lte")).toEqual([100, 200]);
    }),
  );

  test.effect("orders the best matches by a metric without lifting a weaker match into them", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(803);
      const [closest, close, popular] = [repoId(8201), repoId(8202), repoId(8203)];
      yield* seed(owner, [
        { id: closest, summary: "terminal dashboard", weights: { 0: 1 }, metrics: { stars: 10, stars90d: 0 } },
        { id: close, summary: "terminal dashboard", weights: { 0: 1, 1: 0.2 }, metrics: { stars: 9_000, stars90d: 0 } },
        { id: popular, summary: "photo editor", weights: { 0: 1, 1: 3 }, metrics: { stars: 90_000, stars90d: 0 } },
      ]);
      const query = { scope: stars(owner), text: "terminal dashboard", embedding: embedding({ 0: 1 }) };

      const relevance = yield* db.search.hybrid(hybrid({ ...query, limit: 10 }));
      expect(relevance.map((hit) => hit.repo.id)).toEqual([closest, close, popular]);

      const ranked = (direction: "highest" | "lowest") =>
        db.search
          .hybrid(hybrid({ ...query, limit: 2, metrics: [starsMetric], rankBy: { metric: "stars", direction } }))
          .pipe(Effect.map((hits) => hits.map((hit) => [hit.repo.id, hit.metrics[0]])));
      expect(yield* ranked("highest")).toEqual([
        [close, 9_000],
        [closest, 10],
      ]);
      expect(yield* ranked("lowest")).toEqual([
        [closest, 10],
        [close, 9_000],
      ]);
    }),
  );

  test.effect("ranks an exact repo name first, by name or owner and name", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(804);
      const [named, similar] = [repoId(8301), repoId(8302)];
      yield* seed(owner, [
        { id: named, name: "ratatui", weights: { 1: 1 } },
        { id: similar, name: "tui-rs", weights: { 0: 1 } },
      ]);
      const query = { scope: stars(owner), text: "", embedding: embedding({ 0: 1 }), limit: 10 };

      expect((yield* db.search.hybrid(hybrid(query)))[0]?.repo.id).toBe(similar);
      for (const name of ["ratatui", "OWNER/Ratatui"]) {
        const hits = yield* db.search.hybrid(hybrid({ ...query, name }));
        expect(hits.map((hit) => [hit.repo.id, hit.nameMatch])).toEqual([
          [named, true],
          [similar, false],
        ]);
      }
    }),
  );

  test.effect("returns nothing for a query that matches no star", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(805);
      yield* seed(owner, [{ id: repoId(8401), language: "Go" }]);
      const hits = yield* db.search.hybrid(
        hybrid({
          scope: stars(owner),
          text: "zzzz",
          embedding: embedding({ 0: 1 }),
          limit: 10,
          filters: { ...Db.noFilters, languages: ["cobol"] },
        }),
      );
      expect(hits).toEqual([]);
    }),
  );

  test.effect("dies when a ranking names a metric the search does not compute", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(808);
      yield* seed(owner, [{ id: repoId(8701), metrics: { stars: 1, stars90d: 0 } }]);
      const exit = yield* db.search
        .hybrid(
          hybrid({
            scope: stars(owner),
            text: "",
            embedding: embedding({ 5: 1 }),
            limit: 10,
            rankBy: { metric: "stars", direction: "highest" },
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  );

  test.effect("matches a language filter on the repo's topics as well as its language", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = accountId(806);
      const [written, tagged, neither] = [repoId(8501), repoId(8502), repoId(8503)];
      yield* seed(owner, [
        { id: written, language: "Python" },
        { id: tagged, language: "Rust", topics: ["python", "packaging"] },
        { id: neither, language: "Rust", topics: ["cli"] },
      ]);
      const hits = yield* db.search.hybrid(
        hybrid({
          scope: stars(owner),
          text: "",
          embedding: embedding({ 5: 1 }),
          limit: 10,
          filters: { ...Db.noFilters, languages: ["Python"] },
        }),
      );
      expect(hits.map((hit) => hit.repo.id).sort()).toEqual([written, tagged]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite search", searchCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }))("node-postgres search", searchCases);
