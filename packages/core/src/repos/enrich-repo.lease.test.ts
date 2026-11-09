import { expect } from "bun:test";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import { decodeFacets } from "@stargrep/knowledge/claims";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as RepoKnowledge from "../knowledge/repo-knowledge.ts";
import { embeddingModel, fixture, id, oid } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";

// Overlapping enrichment attempts, interleaved with deferred gates at the points the reviews of #93 found unsafe. The
// queue consumer runs one batch at a time, so these need a second consumer, a local run, or a batch beside it.

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

const invalid = { output: { summary: "Broken", keywords: "not a list" }, usage: { inputTokens: 1, outputTokens: 1 } };

for (const [adapter, database] of adapters) {
  const f = fixture();
  const query = (text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) => test.query(text, values));
  const retryAt = (n: number) =>
    query("select to_char(enrich_retry_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') as at from repos where id = $1", [
      n,
    ]);

  it.layer(f.enrichment(database), { timeout: 30_000 })(`enrichment leases on ${adapter}`, (it) => {
    it.effect("a consumer that planned a summary pays nothing once another has saved it", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.remotes.set(800, { description: "A CLI", readme: { oid: oid("8"), text: "# Tool" } });
        yield* f.store([800]);
        const bothPlanned = yield* Deferred.make<void>();
        const captured = yield* Deferred.make<void>();
        const embedding = yield* Deferred.make<void>();
        let leasing = 0;
        let calls = 0;
        const meeting = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            repos: {
              ...db.repos,
              lease: (lease) =>
                Effect.gen(function* () {
                  const mine = ++leasing;
                  if (mine === 2) yield* Deferred.succeed(bothPlanned, undefined);
                  yield* Deferred.await(bothPlanned);
                  if (mine === 2) yield* Deferred.await(captured);
                  const leased = yield* db.repos.lease(lease);
                  if (mine === 2) yield* Deferred.succeed(embedding, undefined);
                  return leased;
                }),
            },
            knowledge: {
              ...db.knowledge,
              capture: (answers) =>
                db.knowledge.capture(answers).pipe(Effect.tap(() => Deferred.succeed(captured, undefined))),
            },
          }),
        );
        const text = f.textGeneration((request) =>
          Effect.sync(() => {
            calls++;
            return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
          }),
        );
        // The first consumer embeds only once the second has tried its lease, so the repo is still due its embedding.
        const embeddings = f.embeddingsWith((values) => Deferred.await(embedding).pipe(Effect.as(f.vectors(values))));
        const consumer = f
          .enrichOne(id(800))
          .pipe(
            Effect.provide(
              Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.mergeAll(meeting, text, embeddings))),
            ),
          );
        const outcomes = yield* Effect.all([consumer, consumer], { concurrency: 2 });
        expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Backoff", "Summarized"]);
        expect(calls).toBe(1);
        expect(yield* query("select count(*)::int as receipts from receipts where repo_id = 800")).toEqual([
          { receipts: 1 },
        ]);
      }),
    );

    it.effect("an invalid answer is counted before its lease ends, so an overlapping consumer cannot pay again", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.remotes.set(801, { description: "Invalid output", readme: { oid: oid("8"), text: "# Tool" } });
        yield* f.store([801]);
        const settled = yield* Deferred.make<void>();
        let calls = 0;
        const meeting = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            repos: {
              ...db.repos,
              settleFailures: (failures) =>
                db.repos.settleFailures(failures).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
            },
          }),
        );
        const text = f.textGeneration(() => Effect.sync(() => (calls++, invalid)));
        const consumer = f
          .enrichOne(id(801))
          .pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(meeting, text)))));
        const outcomes = yield* Effect.all([consumer, Deferred.await(settled).pipe(Effect.andThen(consumer))], {
          concurrency: 2,
        });
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Failed", "Backoff"]);
        expect(calls).toBe(1);
        expect(yield* f.failuresOf(801)).toEqual([{ enrich_failures: 1 }]);
      }),
    );

    // The queue consumer's deadline can stop a chunk while it projects, so a failure settled after projection could
    // go uncounted while its repo stays leased.
    it.effect("settles a failed call before the chunk projects its saved answers", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const test = yield* TestDatabase.TestDatabase;
        for (const n of [820, 821])
          f.remotes.set(n, { description: `Repo ${n}`, readme: { oid: oid("8"), text: "# Tool" } });
        yield* f.store([820, 821]);
        const seen: Array<unknown> = [];
        const watching = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              project: (ids, compute) =>
                test.query("select enrich_failures from repos where id = 821").pipe(
                  Effect.tap((failures) => Effect.sync(() => seen.push(...failures))),
                  Effect.andThen(db.knowledge.project(ids, compute)),
                ),
            },
          }),
        );
        const text = f.textGeneration((request) =>
          Effect.sync(() =>
            request.prompt.includes("owner/repo-821\n")
              ? invalid
              : { output: SummarizeFake.respond(request.prompt), usage: f.usage },
          ),
        );
        const outcomes = yield* EnrichRepo.EnrichRepo.use((service) => service.enrichRepos([id(820), id(821)])).pipe(
          Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(watching, text)))),
        );
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Summarized", "Failed"]);
        expect(seen[0]).toEqual({ enrich_failures: 1 });
      }),
    );

    it.effect("every invalid paid answer counts, however many consumers overlap", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.remotes.set(804, { description: "Invalid output", readme: { oid: oid("8"), text: "# Tool" } });
        yield* f.store([804]);
        let calls = 0;
        const text = f.textGeneration(() => Effect.sync(() => (calls++, invalid)));
        const settled = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>());
        const consumer = (mine: number) => {
          const meeting = Layer.succeed(
            Db.Db,
            Db.Db.of({
              ...db,
              repos: {
                ...db.repos,
                settleFailures: (failures) =>
                  db.repos.settleFailures(failures).pipe(Effect.andThen(Deferred.succeed(settled[mine]!, undefined))),
              },
            }),
          );
          const previous = settled[mine - 1];
          return (previous === undefined ? Effect.void : Deferred.await(previous)).pipe(
            Effect.andThen(
              f
                .enrichOne(id(804))
                .pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(meeting, text))))),
            ),
          );
        };
        const outcomes = yield* Effect.forEach([0, 1, 2, 3], consumer, { concurrency: 4 });
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Failed", "Backoff", "Backoff", "Backoff"]);
        expect(calls).toBe(1);
        expect(yield* f.failuresOf(804)).toEqual([{ enrich_failures: 1 }]);
      }),
    );

    it.effect("a provider batch holds its lease for the batch's whole wait", () =>
      Effect.gen(function* () {
        for (const n of [802, 803])
          f.remotes.set(n, { description: "A CLI", readme: { oid: oid("8"), text: "# Tool" } });
        yield* f.store([802, 803]);
        const submitted = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        let batchCalls = 0;
        let directCalls = 0;
        const batch = Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.make({
            provider: "test",
            model: "test/text",
            timeout: Duration.seconds(5),
            run: () => Effect.die("unexpected direct fallback"),
            batch: {
              timeout: Duration.hours(24),
              run: (request) =>
                Effect.gen(function* () {
                  batchCalls += request.prompts.length;
                  yield* Deferred.succeed(submitted, undefined);
                  yield* Deferred.await(answer);
                  return request.prompts.map((prompt) =>
                    Result.succeed({ output: SummarizeFake.respond(prompt), usage: f.usage }),
                  );
                }),
            },
          }),
        );
        const enrichBoth = EnrichRepo.EnrichRepo.use((service) => service.enrichRepos([id(802), id(803)]));
        const batchRun = yield* Effect.forkChild(enrichBoth.pipe(f.using(batch)));
        yield* Deferred.await(submitted);
        yield* TestClock.adjust("20 hours");
        const direct = f.textGeneration((request) =>
          Effect.sync(() => {
            directCalls++;
            return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
          }),
        );
        const overlapping = yield* enrichBoth.pipe(f.using(direct));
        yield* Deferred.succeed(answer, undefined);
        const batched = yield* Fiber.join(batchRun);
        expect(overlapping.map((outcome) => outcome._tag)).toEqual(["Backoff", "Backoff"]);
        expect(batched.map((outcome) => outcome._tag)).toEqual(["Summarized", "Summarized"]);
        expect({ batchCalls, directCalls }).toEqual({ batchCalls: 2, directCalls: 0 });
      }),
    );

    it.effect("a late answer whose lease ran out leaves a later attempt's lease alone", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* f.store([805]);
        const row = yield* db.repos.require(id(805));
        const old = yield* db.repos.saveFacts({ ...row, description: "Before" });
        const before = yield* DateTime.now;
        const first = DateTime.addDuration(before, Duration.minutes(15));
        yield* db.repos.lease({ ids: [id(805)], now: before, until: first });
        yield* TestClock.adjust("16 minutes");
        yield* db.repos.saveFacts({ ...row, description: "After" });
        const now = yield* DateTime.now;
        const successor = { ids: [id(805)], now, until: DateTime.addDuration(now, Duration.minutes(15)) };
        expect(yield* db.repos.lease(successor)).toEqual([id(805)]);
        const captured = yield* RepoKnowledge.capture([
          {
            repoId: id(805),
            inputHash: old.inputHash,
            readmeOid: row.readmeOid,
            source: "model",
            model: "test/text",
            answer: {
              summary: "Before summary",
              keywords: [],
              facets: decodeFacets([], { fullName: "owner/repo-805", description: "Before", topics: [], readme: "" }),
            },
            lease: first,
          },
        ]);
        expect(captured.map((outcome) => outcome._tag)).toEqual(["Stale"]);
        expect(yield* retryAt(805)).toEqual([
          { at: DateTime.formatIso(successor.until).slice(0, 16).replace("T", " ") },
        ]);
        expect(yield* db.repos.lease(successor)).toEqual([]);
      }),
    );

    // A lone surrogate or U+0000 in model text: Postgres refuses both in jsonb, and the facts decoder already cleans them.
    for (const [name, summary, saved, keyword, savedKeyword] of [
      [
        "a lone surrogate",
        "A party tool \ud83d for emoji.",
        "A party tool \ufffd for emoji.",
        "emoji\udc00",
        "emoji\ufffd",
      ],
      ["U+0000", "A party tool \u0000 for emoji.", "A party tool  for emoji.", "emoji\u0000", "emoji"],
    ] as const) {
      it.effect(`saves a summary holding ${name} after one paid call`, () =>
        Effect.gen(function* () {
          const n = name === "U+0000" ? 807 : 806;
          f.remotes.set(n, { description: "Emoji heavy", readme: { oid: oid("8"), text: "# Tool" } });
          let calls = 0;
          const text = f.textGeneration(() =>
            Effect.sync(() => {
              calls++;
              return { output: { summary, keywords: [keyword], facets: [] }, usage: f.usage };
            }),
          );
          expect(yield* f.enrich(n).pipe(f.using(text))).toMatchObject({ _tag: "Summarized" });
          yield* TestClock.adjust("16 minutes");
          expect(yield* f.enrich(n).pipe(f.using(text))).toMatchObject({ _tag: "Unchanged" });
          expect(calls).toBe(1);
          expect(yield* f.get(n)).toMatchObject({ summary: saved, keywords: [savedKeyword] });
        }),
      );
    }

    // A capture that times out behind a mint, loses its connection, or loses a deadlock says nothing about the answer.
    for (const reason of ["timeout", "transport", "conflict"] as const) {
      it.effect(`a ${reason} while saving counts nothing and keeps the lease until it runs out`, () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const n = { timeout: 830, transport: 831, conflict: 832 }[reason];
          f.remotes.set(n, { description: "A CLI", readme: { oid: oid("3"), text: "# Tool" } });
          yield* f.store([n]);
          const lost = Layer.succeed(
            Db.Db,
            Db.Db.of({
              ...db,
              knowledge: {
                ...db.knowledge,
                capture: () =>
                  Effect.fail(new DbQueryFailed({ operation: "knowledge.capture", reason, sqlState: null })),
              },
            }),
          );
          let calls = 0;
          const text = f.textGeneration((request) =>
            Effect.sync(() => (calls++, { output: SummarizeFake.respond(request.prompt), usage: f.usage })),
          );
          for (let round = 0; round < 3; round++) {
            const leasedAt = yield* DateTime.now;
            const outcome = yield* f
              .enrichOne(id(n))
              .pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(lost, text)))));
            expect(outcome).toMatchObject({
              _tag: "Failed",
              error: { _tag: "AnswerNotSaved", reason, refused: false },
            });
            expect(yield* f.failuresOf(n)).toEqual([{ enrich_failures: 0 }]);
            const lease = DateTime.addDuration(leasedAt, Duration.minutes(15));
            expect(yield* retryAt(n)).toEqual([{ at: DateTime.formatIso(lease).slice(0, 16).replace("T", " ") }]);
            const sweepable = (at: DateTime.Utc) => db.repos.sweepable({ now: at, limit: 1000 });
            expect(yield* sweepable(yield* DateTime.now)).not.toContain(id(n));
            yield* TestClock.adjust("16 minutes");
            expect(yield* sweepable(yield* DateTime.now)).toContain(id(n));
          }
          expect(calls).toBe(3);
        }),
      );
    }

    it.effect("an answer capture cannot save fails only its own repo, counted, and its chunk-mates are saved", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const numbers = Array.from({ length: 10 }, (_, index) => 810 + index);
        for (const n of numbers)
          f.remotes.set(n, { description: `Repo ${n}`, readme: { oid: oid("9"), text: "# Tool" } });
        yield* f.store(numbers);
        const poisoned = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              capture: (answers) =>
                answers.some((answer) => answer.repoId === id(810))
                  ? Effect.fail(
                      new DbQueryFailed({ operation: "knowledge.capture", reason: "query", sqlState: "22P02" }),
                    )
                  : db.knowledge.capture(answers),
            },
          }),
        );
        let calls = 0;
        const text = f.textGeneration((request) =>
          Effect.sync(() => {
            calls++;
            return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
          }),
        );
        const outcomes = yield* EnrichRepo.EnrichRepo.use((service) => service.enrichRepos(numbers.map(id))).pipe(
          Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(poisoned, text)))),
        );
        expect(calls).toBe(10);
        expect(outcomes[0]).toMatchObject({
          _tag: "Failed",
          error: { _tag: "AnswerNotSaved", sqlState: "22P02", refused: true },
        });
        expect(outcomes.slice(1).map((outcome) => outcome._tag)).toEqual(numbers.slice(1).map(() => "Summarized"));
        expect(yield* f.failuresOf(810)).toEqual([{ enrich_failures: 1 }]);
        const backoff = DateTime.addDuration(yield* DateTime.now, Duration.minutes(10));
        expect(yield* retryAt(810)).toEqual([{ at: DateTime.formatIso(backoff).slice(0, 16).replace("T", " ") }]);
      }),
    );
  });
}
