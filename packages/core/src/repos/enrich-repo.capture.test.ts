import { expect } from "bun:test";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import * as TestDatabase from "@stargrep/db/test-database";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { embeddingModel, fixture, id, oid } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";

const f = fixture();

const query = (text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(TestDatabase.TestDatabase, (database) => database.query(text, values));

const sweepable = Effect.flatMap(Db.Db, (db) =>
  Effect.flatMap(DateTime.now, (now) => db.repos.sweepable({ now, limit: 1000 })),
);

it.layer(f.enrichment(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })(
  "enrichment saves answers through capture",
  (it) => {
    it.effect("keeps the answer as a receipt and projects the repo's atoms", () =>
      Effect.gen(function* () {
        f.remotes.set(600, { description: "A fast CLI for macOS", readme: { oid: oid("6"), text: "# Tool" } });
        expect(yield* f.enrich(600)).toMatchObject({ _tag: "Summarized" });
        expect(
          yield* query(
            `select c.source, c.model, c.recipe, c.input_hash = r.input_hash as "answersInputs",
               r.summary_input_hash = r.input_hash as "current", r.kinds::text[] as kinds,
               r.runs_on::text[] as "runsOn", r.written_in::text[] as "writtenIn", f.stale
             from repos r join receipts c on c.id = r.receipt_id join repo_facets f on f.repo_id = r.id
             where r.id = 600`,
          ),
        ).toEqual([
          {
            source: "stand-in",
            model: "fake/text",
            recipe: 2,
            answersInputs: true,
            current: true,
            kinds: ["cli"],
            runsOn: ["macos"],
            writtenIn: ["rust"],
            stale: false,
          },
        ]);
      }),
    );

    it.effect("never fails a summary or counts a failure for a fact it cannot read", () =>
      Effect.gen(function* () {
        f.remotes.set(601, { description: "Notes", readme: { oid: oid("6"), text: "# Notes" } });
        const sloppy = f.textGeneration(() =>
          Effect.succeed({
            output: {
              summary: "A notes app.",
              keywords: ["notes"],
              facets: [{ role: "maintainer", term: "someone" }, { role: "is", term: "" }, "app", 7],
            },
            usage: f.usage,
          }),
        );
        expect(yield* f.enrich(601).pipe(f.using(sloppy))).toMatchObject({ _tag: "Summarized" });
        expect(yield* f.failuresOf(601)).toEqual([{ enrich_failures: 0 }]);
        expect(
          yield* query(
            "select c.lanes ->> 'is' as lane from repos r join receipts c on c.id = r.receipt_id where r.id = 601",
          ),
        ).toEqual([{ lane: "invalid" }]);
      }),
    );

    it.effect("counts an answer that does not decode toward the cap, three times at most", () =>
      Effect.gen(function* () {
        f.remotes.set(602, { description: "Broken", readme: { oid: oid("6"), text: "# Broken" } });
        let calls = 0;
        const truncated = f.textGeneration(() =>
          Effect.sync(() => {
            calls++;
            return { output: { summary: "A cut-off answer", keywords: "not a list" }, usage: f.usage };
          }),
        );
        for (const wait of ["0 minutes", "10 minutes", "1 hour"] as const) {
          yield* TestClock.adjust(wait);
          expect(yield* f.enrich(602).pipe(f.using(truncated))).toMatchObject({
            _tag: "Failed",
            error: { _tag: "AiOutputInvalid" },
          });
        }
        expect(calls).toBe(3);
        expect(yield* f.failuresOf(602)).toEqual([{ enrich_failures: 3 }]);
        expect(yield* sweepable).not.toContain(id(602));
      }),
    );

    it.effect("returns Stale when the description changes while the model runs, and the repo stays due", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.remotes.set(603, { description: "Before", readme: { oid: oid("6"), text: "# Tool" } });
        yield* f.store([603]);
        const moving = f.textGeneration((request) =>
          Effect.flatMap(db.repos.require(id(603)), (row) =>
            db.repos
              .saveFacts({ ...row, description: "After" })
              .pipe(Effect.as({ output: SummarizeFake.respond(request.prompt), usage: f.usage }), Effect.orDie),
          ).pipe(Effect.orDie),
        );
        expect(yield* f.enrichOne(id(603)).pipe(f.using(moving))).toEqual({ _tag: "Stale", id: id(603) });
        expect(yield* f.get(603)).toMatchObject({ summary: null, description: "After" });
        expect(yield* db.repos.pendingEnrichment([id(603)])).toEqual([id(603)]);
        expect(yield* sweepable).toContain(id(603));
      }),
    );

    it.effect("returns Stale for a repo GitHub stopped serving while the model ran, and never sends it again", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        f.remotes.set(604, { description: "Gone soon", readme: { oid: oid("6"), text: "# Tool" } });
        const forgetting = f.textGeneration((request) =>
          database
            .query("update repos set gone_at = now() where id = 604")
            .pipe(Effect.as({ output: SummarizeFake.respond(request.prompt), usage: f.usage })),
        );
        expect(yield* f.enrich(604).pipe(f.using(forgetting))).toEqual({ _tag: "Stale", id: id(604) });
        expect(yield* f.get(604)).toMatchObject({ summary: null });
        expect(yield* query("select count(*)::int as receipts from receipts where repo_id = 604")).toEqual([
          { receipts: 1 },
        ]);
        expect(yield* db.repos.pendingEnrichment([id(604)])).toEqual([]);
        expect(yield* sweepable).not.toContain(id(604));
      }),
    );

    // Enrichment reads facts only for a due repo, so changed topics take effect once a facts save records them.
    it.effect("asks the model again, not only the embedder, once a facts save records changed topics", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const remote = { description: "A TUI", readme: { oid: oid("6"), text: "# Tool" } };
        f.remotes.set(605, { ...remote, topics: ["tui"] });
        expect(yield* f.enrich(605)).toMatchObject({ _tag: "Summarized" });
        expect(yield* f.enrich(605)).toMatchObject({ _tag: "Unchanged" });

        f.remotes.set(605, { ...remote, topics: ["tui", "rust"] });
        const row = yield* db.repos.require(id(605));
        expect(yield* db.repos.saveFacts({ ...row, topics: ["tui", "rust"] })).toMatchObject({ pending: true });
        const asked = f.prompts.length;
        expect(yield* f.enrich(605)).toMatchObject({ _tag: "Summarized" });
        expect(f.prompts.slice(asked)).toEqual([expect.stringContaining("Topics: tui, rust")]);
        expect(yield* db.repos.pendingEnrichment([id(605)])).toEqual([]);
      }),
    );

    it.effect("makes one paid call when two consumers get the same repo at once", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.remotes.set(606, { description: "Popular", readme: { oid: oid("6"), text: "# Tool" } });
        yield* f.store([606]);
        // Both consumers plan the repo before either leases it, the closest the queue can bring them.
        const bothPlanned = yield* Deferred.make<void>();
        let leasing = 0;
        const meeting = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            repos: {
              ...db.repos,
              lease: (lease) =>
                Effect.suspend(() => {
                  leasing++;
                  return leasing === 2 ? Deferred.succeed(bothPlanned, undefined) : Effect.void;
                }).pipe(Effect.andThen(Deferred.await(bothPlanned)), Effect.andThen(db.repos.lease(lease))),
            },
          }),
        );
        let calls = 0;
        const counting = f.textGeneration((request) =>
          Effect.sync(() => {
            calls++;
            return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
          }),
        );
        const consumer = f
          .enrichOne(id(606))
          .pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(meeting, counting)))));
        const outcomes = yield* Effect.all([consumer, consumer], { concurrency: 2 });
        expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Backoff", "Summarized"]);
        expect(calls).toBe(1);
        expect(yield* query("select count(*)::int as receipts from receipts where repo_id = 606")).toEqual([
          { receipts: 1 },
        ]);
      }),
    );
  },
);
