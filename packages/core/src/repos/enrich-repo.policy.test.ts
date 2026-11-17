import { expect } from "bun:test";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import * as TestDatabase from "@stargrep/db/test-database";
import { GitHubAccountId, Login, type RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import { embeddingModel, fixture, id, oid, repo } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as SummaryAllowance from "./summary-allowance.ts";

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

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
  const enrich = (
    ids: ReadonlyArray<RepoId>,
    allowance: Layer.Layer<SummaryAllowance.SummaryAllowance, never, Db.Db> = SummaryAllowance.layerUnmetered,
  ) =>
    EnrichRepo.EnrichRepo.use((enricher) => enricher.enrichRepos(ids)).pipe(
      Effect.map((outcomes) => outcomes.map((outcome) => outcome._tag)),
      Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.mergeAll(text, recording, allowance)))),
    );
  // A repo as a star list shows it, with GitHub's count of its stars, which GitHub also serves in its facts.
  const listed = (n: number, stars: number) => {
    const description = `Repo ${n}`;
    f.remotes.set(n, { description, stars, readme: { oid: oid("d"), text: "# Repo" } });
    return Effect.flatMap(Db.Db, (db) =>
      db.repos.saveListed([{ ...repo(n), description, topics: ["cli"], language: null, stars }]),
    ).pipe(Effect.as(id(n)));
  };
  const swept = Effect.flatMap(Db.Db, (db) =>
    Effect.flatMap(DateTime.now, (now) => db.repos.sweepable({ now, limit: 1000 })),
  );
  const stateOf = (n: number) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) =>
      test.query(
        `select embedding_source as source, embedding is not null as embedded, summary is not null as summarized,
          enrich_failures as failures, enrich_retry_at is null as free
        from repos where id = $1`,
        [n],
      ),
    );
  const quiet = () => {
    f.github.sent.length = 0;
    f.iconQueue.sent.length = 0;
    embedded.length = 0;
    calls = 0;
  };

  it.layer(f.enrichment(database), { timeout: 30_000 })(`summary policy on ${adapter}`, (it) => {
    it.effect("leaves a repo below the floors on its metadata embedding, with no GitHub read and off the sweep", () =>
      Effect.gen(function* () {
        const repoId = yield* listed(2201, 120);
        expect(yield* swept).not.toContain(repoId);
        quiet();

        expect(yield* enrich([repoId])).toEqual(["Unwanted"]);
        expect(f.github.sent).toEqual([]);
        expect(f.iconQueue.sent).toEqual([]);
        expect(calls).toBe(0);
        expect(embedded).toEqual(["owner/repo-2201\nRepo 2201\ncli"]);
        expect(yield* stateOf(2201)).toEqual([
          { source: "metadata", embedded: true, summarized: false, failures: 0, free: true },
        ]);

        expect(yield* enrich([repoId])).toEqual(["Unwanted"]);
        expect(embedded).toHaveLength(1);
        expect(f.github.sent).toEqual([]);
        expect(yield* swept).not.toContain(repoId);
      }),
    );

    it.effect("summarizes the repo once a star list moves its count past the floor", () =>
      Effect.gen(function* () {
        const repoId = yield* listed(2202, 150);
        expect(yield* enrich([repoId])).toEqual(["Unwanted"]);
        expect(yield* swept).not.toContain(repoId);

        yield* listed(2202, 260);
        expect(yield* swept).toContain(repoId);
        quiet();
        expect(yield* enrich([repoId])).toEqual(["Summarized"]);
        expect(calls).toBe(1);
        expect(yield* stateOf(2202)).toEqual([
          { source: "summary", embedded: true, summarized: true, failures: 0, free: true },
        ]);
      }),
    );

    it.effect("summarizes the repo once a signed-in user stars it", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const test = yield* TestDatabase.TestDatabase;
        const repoId = yield* listed(2203, 20);
        expect(yield* enrich([repoId])).toEqual(["Unwanted"]);

        const userId = UserId.make("user-policy-ada");
        const accountId = GitHubAccountId.make(2203);
        yield* test.query("insert into \"user\" (id, name, email) values ($1, $1, $1 || '@example.com')", [userId]);
        yield* db.accounts.claim({
          facts: {
            id: accountId,
            type: "user",
            login: Login.make("policy-ada"),
            name: null,
            avatarUrl: null,
            followers: null,
            publicRepos: null,
          },
          userId,
          starredCount: 1,
        });
        yield* db.stars.upsert({
          accountId,
          stars: [
            {
              repoId,
              starredAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
              observedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
              source: "api",
            },
          ],
        });
        expect(yield* swept).not.toContain(repoId);
        yield* db.repos.markUserStarred(accountId);
        expect(yield* swept).toContain(repoId);
        quiet();
        expect(yield* enrich([repoId])).toEqual(["Summarized"]);
        expect(calls).toBe(1);
      }),
    );

    it.effect(
      "reads the facts of a repo whose count is unknown, and stops before its README when they hold it back",
      () =>
        Effect.gen(function* () {
          f.remotes.set(2204, { description: "Repo 2204", stars: 90, readme: { oid: oid("d"), text: "# Repo" } });
          yield* f.store([2204]);
          const repoId = id(2204);
          expect(yield* swept).toContain(repoId);
          quiet();

          expect(yield* enrich([repoId])).toEqual(["Unwanted"]);
          expect(f.github.sent).toHaveLength(1);
          expect([f.readmeRequests(), f.readmeBatches(), calls]).toEqual([0, 0, 0]);
          expect(embedded).toEqual(["owner/repo-2204\nRepo 2204\ncli"]);
          expect(yield* swept).not.toContain(repoId);
        }),
    );

    it.effect("spends the summary cap's last unit on the repo with more stars, whatever its ID", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* TestClock.setTime(Date.parse("2026-11-20T00:00:00Z"));
        const reserved = yield* RateLine.reserve(
          db.rateLines,
          RateLine.summaryAll,
          yield* DateTime.now,
          RateLine.summariesPerDay - 1,
        );
        expect(Option.isSome(reserved)).toBe(true);
        const fewer = yield* listed(2205, 300);
        const more = yield* listed(2206, 9000);
        quiet();

        expect(yield* enrich([fewer, more], SummaryAllowance.layerMetered)).toEqual(["Capped", "Summarized"]);
        expect(calls).toBe(1);
        expect(yield* swept).not.toContain(fewer);
        yield* TestClock.adjust(RateLine.durationOf(RateLine.summaryAll.rate, 1));
        expect(yield* swept).toContain(fewer);
      }),
    );
  });
}
