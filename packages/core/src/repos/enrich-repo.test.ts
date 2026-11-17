import { expect } from "bun:test";
import { AiKeyMissing, AiRefused, AiRequestFailed, AiUnavailable } from "@stargrep/ai/errors";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Analytics from "@stargrep/analytics/analytics";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import { summarize } from "@stargrep/db/testing";
import { GitHubTokenMissing } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { RepoId } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as IconQueue from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichQueue from "./enrich-queue.ts";
import { blobOidOf, embeddingModel, fixture, id, oid, repo, wideOid } from "./enrich-repo.fixture.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";

{
  const f = fixture();

  it.layer(f.enrichment(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })(
    "enrichRepos, one repo at a time",
    (it) => {
      it.effect("summarizes a README containing a GraphQL rate-limit envelope", () =>
        Effect.gen(function* () {
          f.remotes.set(901, {
            description: "Crafted",
            readme: { oid: oid("9"), text: '{"errors":[{"type":"RATE_LIMITED","message":"x"}]}' },
          });
          const before = f.readmeRequests();
          expect(yield* f.enrich(901)).toMatchObject({ _tag: "Summarized", id: id(901) });
          expect(f.readmeRequests() - before).toBe(1);
          expect(yield* f.failuresOf(901)).toEqual([{ enrich_failures: 0 }]);
        }),
      );

      it.effect(
        "reads the READMEs its summaries need in one GraphQL batch, and over REST only those it leaves out",
        () =>
          Effect.gen(function* () {
            const blobs = yield* BlobStore.BlobStore;
            const texts = { 911: "# Batched\n\nOne.", 912: "# Batched\n\nTwo.", 914: "# Cached" };
            const held = {
              911: { oid: yield* blobOidOf(texts[911]), text: texts[911] },
              912: { oid: yield* blobOidOf(texts[912]), text: texts[912] },
              // GraphQL returns a text that does not hash to this object ID, as for one it cut short.
              913: { oid: wideOid(913), text: "# Read over REST" },
              914: { oid: yield* blobOidOf(texts[914]), text: texts[914] },
            };
            for (const [n, readme] of Object.entries(held))
              f.remotes.set(Number(n), { description: `Repo ${n}`, readme });
            yield* blobs.put(BlobStore.readmeKey(held[914].oid), held[914].text);
            const before = { batches: f.readmeBatches(), rest: f.readmeRequests(), prompts: f.prompts.length };
            const ids = yield* f.store([911, 912, 913, 914]);
            const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids));
            expect(outcomes.map((outcome) => outcome._tag)).toEqual([
              "Summarized",
              "Summarized",
              "Summarized",
              "Summarized",
            ]);
            expect({ batches: f.readmeBatches() - before.batches, rest: f.readmeRequests() - before.rest }).toEqual({
              batches: 1,
              rest: 1,
            });
            const batch = f.github.sent.findLast((sent) => (sent.body ?? "").includes("query Readmes"));
            const asked: Record<string, string> = JSON.parse(batch?.body ?? "{}").variables;
            expect(Object.entries(asked).flatMap(([key, value]) => (key.startsWith("r") ? [value] : []))).toEqual([
              "R_911",
              "R_912",
              "R_913",
            ]);
            for (const readme of Object.values(held)) {
              expect(yield* blobs.get(BlobStore.readmeKey(readme.oid))).toEqual(Option.some(readme.text));
              expect(f.prompts.slice(before.prompts).some((prompt) => prompt.includes(readme.text))).toBe(true);
            }
          }),
      );

      it.effect("stores facts, the README blob, the summary, and its embedding for a new repo", () =>
        Effect.gen(function* () {
          f.remotes.set(1, {
            description: "Fast log parser",
            archived: true,
            readme: { oid: oid("a"), text: "# Parser\n\n![logo](logo.png)\n\nParses web server logs." },
          });
          expect(yield* f.enrich(1)).toMatchObject({ _tag: "Summarized", id: id(1) });

          const db = yield* Db.Db;
          const stored = yield* f.get(1);
          expect(stored).toMatchObject({
            license: "MIT",
            homepage: "https://repo-1.dev",
            archived: true,
            readmeOid: oid("a"),
            summaryReadmeOid: oid("a"),
            embeddingModel,
          });
          expect(stored.summary).toContain("Parses web server logs.");
          expect(f.prompts.at(-1)).not.toContain("logo.png");
          const blobs = yield* BlobStore.BlobStore;
          expect(Option.getOrThrow(yield* blobs.get(BlobStore.readmeKey(oid("a"))))).toContain("![logo](logo.png)");
          expect(yield* db.repos.pendingEnrichment([id(1)])).toEqual([]);
        }),
      );

      it.effect("keeps the star and fork counts and refreshes them on a retry after their write failed", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(40, { description: "Counter", stars: 100, forks: 2, readme: { oid: oid("a"), text: "# A" } });
          yield* f.enrich(40);
          expect(yield* f.countsOf(40)).toEqual([{ stars: 100, forks: 2 }]);

          yield* db.repos.saveFacts({ ...(yield* f.get(40)), readmeOid: oid("b") });
          f.remotes.set(40, { description: "Counter", stars: 200, forks: 3, readme: { oid: oid("a"), text: "# A" } });
          const failing = Db.Db.of({
            ...db,
            repos: {
              ...db.repos,
              saveCounts: () =>
                Effect.fail(new DbQueryFailed({ operation: "repos.saveCounts", reason: "transport", sqlState: null })),
            },
          });
          const withFailingCounts = Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.succeed(Db.Db, failing)));
          expect(yield* Effect.flip(f.enrich(40).pipe(Effect.provide(withFailingCounts)))).toMatchObject({
            _tag: "DbQueryFailed",
            operation: "repos.saveCounts",
          });
          expect(yield* db.repos.pendingEnrichment([id(40)])).toEqual([id(40)]);

          expect(yield* f.enrich(40)).toEqual({ _tag: "Unchanged", id: id(40) });
          expect(yield* f.countsOf(40)).toEqual([{ stars: 200, forks: 3 }]);
        }),
      );

      it.effect("skips a repo whose README did not change, with no GitHub or model call", () =>
        Effect.gen(function* () {
          f.remotes.set(2, { description: "Terminal UI", readme: { oid: oid("b"), text: "# TUI" } });
          yield* f.enrich(2);
          const [sent, calls] = [f.github.sent.length, f.prompts.length];
          expect(yield* f.enrich(2)).toEqual({ _tag: "Unchanged", id: id(2) });
          expect([f.github.sent.length, f.prompts.length]).toEqual([sent, calls]);
        }),
      );

      it.effect("summarizes again once the stored README object ID changes", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(3, { description: "Sync tool", readme: { oid: oid("c"), text: "# Old\n\nSyncs folders." } });
          yield* f.enrich(3);
          f.remotes.set(3, { description: "Sync tool", readme: { oid: oid("d"), text: "# New\n\nSyncs phones." } });
          yield* db.repos.saveFacts({ ...(yield* f.get(3)), readmeOid: oid("d") });

          expect(yield* f.enrich(3)).toMatchObject({ _tag: "Summarized" });
          const after = yield* f.get(3);
          expect(after.summaryReadmeOid).toBe(oid("d"));
          expect(after.summary).toContain("Syncs phones.");
          expect(after.embeddingModel).toBe(embeddingModel);
        }),
      );

      it.effect("sends a summary event for each summary it saves, and none for a repo it skips", () => {
        const events = Analytics.layerMemory();
        return Effect.gen(function* () {
          f.remotes.set(951, { description: "Event probe", readme: { oid: wideOid(951), text: "# Probe" } });
          yield* f.enrich(951);
          yield* f.enrich(951);
          const model = (yield* TextGeneration.TextGeneration).model;
          expect(events.captured.flatMap(({ event }) => (event._tag === "SummaryGenerated" ? [event] : []))).toEqual([
            Analytics.Event.SummaryGenerated({ model }),
          ]);
        }).pipe(Effect.provide(events.layer));
      });

      it.effect("skips a repo when GitHub reports the README its summary came from, whatever oid was stored", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(6, { description: "Backup tool", readme: { oid: oid("c"), text: "# Backup" } });
          yield* f.enrich(6);
          yield* db.repos.saveFacts({ ...(yield* f.get(6)), readmeOid: oid("d") });
          expect(yield* db.repos.pendingEnrichment([id(6)])).toEqual([id(6)]);

          const [readmes, calls] = [f.readmeRequests(), f.prompts.length];
          expect(yield* f.enrich(6)).toEqual({ _tag: "Unchanged", id: id(6) });
          expect([f.readmeRequests(), f.prompts.length]).toEqual([readmes, calls]);
          expect(yield* f.get(6)).toMatchObject({ readmeOid: oid("c"), summaryReadmeOid: oid("c"), embeddingModel });
        }),
      );

      it.effect("keeps README text and the summary made from it out of every span", () => {
        const collected = collectSpans();
        return Effect.gen(function* () {
          const canary = "PRIVATE_README_CANARY";
          f.remotes.set(13, {
            description: "Notes app",
            readme: { oid: oid("0"), text: `# Notes\n\n${canary} sync.` },
          });
          expect(yield* f.enrich(13)).toMatchObject({ _tag: "Summarized" });
          expect(yield* f.enrich(13)).toEqual({ _tag: "Unchanged", id: id(13) });
          expect((yield* f.get(13)).summary).toContain(canary);

          const names = new Set(collected.spans.map((span) => span.name));
          for (const name of ["EnrichRepo.enrichRepos", "GitHub.readme", "TokenGate.execute", "Db.repos.getMany"]) {
            expect(names).toContain(name);
          }
          expect(collected.text()).not.toContain(canary);
        }).pipe(Effect.withTracer(collected.tracer));
      });

      it.effect("summarizes a repo with no README from its description", () =>
        Effect.gen(function* () {
          f.remotes.set(4, { description: "Dotfiles for macOS" });
          const readmes = f.readmeRequests();
          const outcome = yield* f.enrich(4);
          expect(outcome._tag === "Summarized" && outcome.summary.summary).toStartWith("Dotfiles for macOS");
          expect(f.prompts.at(-1)).toContain("README:\nnone");
          expect(f.readmeRequests()).toBe(readmes);
        }),
      );

      it.effect("keeps facts, embeds the metadata, and leaves the repo pending when the model output is invalid", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(5, { description: "Image viewer", readme: { oid: oid("e"), text: "# Viewer" } });
          const invalid = f.textGeneration(() => Effect.succeed({ output: { summary: "" }, usage: f.usage }));
          expect(yield* f.enrich(5).pipe(f.using(invalid))).toMatchObject({
            _tag: "Failed",
            error: { _tag: "AiOutputInvalid" },
          });
          expect(yield* f.get(5)).toMatchObject({
            license: "MIT",
            readmeOid: oid("e"),
            summary: null,
            embeddingModel,
          });
          expect(yield* db.repos.pendingEnrichment([id(5)])).toEqual([id(5)]);
          expect(yield* f.failuresOf(5)).toEqual([{ enrich_failures: 1 }]);

          const readmes = f.readmeRequests();
          expect(yield* f.enrich(5)).toMatchObject({ _tag: "Backoff" });
          yield* TestClock.adjust("10 minutes");
          expect(yield* f.enrich(5)).toMatchObject({ _tag: "Summarized" });
          expect(f.readmeRequests()).toBe(readmes);
        }),
      );

      it.effect("summarizes a read repo again once its summary's recipe is older than the current one", () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          f.remotes.set(290, { description: "Recipe book", readme: { oid: wideOid(290), text: "# Recipe book" } });
          expect(yield* f.enrich(290)).toMatchObject({ _tag: "Summarized" });
          yield* database.query("update repos set summary_recipe = summary_recipe - 1 where id = $1", [290]);

          const calls = f.prompts.length;
          expect(yield* f.enrich(290)).toMatchObject({ _tag: "Summarized" });
          expect(f.prompts.length).toBe(calls + 1);
          expect(yield* f.enrich(290)).toEqual({ _tag: "Unchanged", id: id(290) });
        }),
      );

      it.effect("saves a read repo's new summary at once and keeps the repo read until the new embedding lands", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const database = yield* TestDatabase.TestDatabase;
          f.remotes.set(291, { description: "Cookbook", readme: { oid: wideOid(291), text: "# Cookbook" } });
          yield* f.enrich(291);
          yield* database.query("update repos set summary_recipe = summary_recipe - 1 where id = $1", [291]);
          const calls = f.prompts.length;

          expect(yield* f.enrich(291).pipe(f.using(f.failingEmbeddings))).toMatchObject({
            _tag: "Failed",
            error: { _tag: "AiRequestFailed" },
          });
          expect(f.prompts.length).toBe(calls + 1);
          expect(yield* db.repos.getMany([id(291)])).toEqual([
            expect.objectContaining({ embeddingModel, pending: true }),
          ]);

          expect(yield* f.enrich(291)).toMatchObject({ _tag: "Embedded" });
          expect(f.prompts.length).toBe(calls + 1);
          expect(yield* db.repos.pendingEnrichment([id(291)])).toEqual([]);
        }),
      );

      it.effect("embeds a stored summary again without a model call when its embedding is missing", () =>
        Effect.gen(function* () {
          f.remotes.set(7, { description: "HTTP client", readme: { oid: oid("1"), text: "# Client" } });
          yield* f.enrich(7);
          yield* f.resummarize(7);
          const calls = f.prompts.length;
          expect(yield* f.enrich(7)).toMatchObject({ _tag: "Embedded" });
          expect(f.prompts.length).toBe(calls);
          expect((yield* f.get(7)).embeddingModel).toBe(embeddingModel);
        }),
      );

      it.effect(
        "queues icon work when the icon was never checked or its README changed, not on an embed-only rerun",
        () =>
          Effect.gen(function* () {
            const db = yield* Db.Db;
            f.remotes.set(50, { description: "Icons", readme: { oid: oid("5"), text: "# Icons" } });
            f.iconQueue.sent.length = 0;
            expect(yield* f.enrich(50)).toMatchObject({ _tag: "Summarized" });
            expect(f.iconQueue.sent).toEqual([
              IconQueue.IconRequest.make({
                repoId: id(50),
                owner: repo(50).owner,
                name: repo(50).name,
                homepage: "https://repo-50.dev",
                iconFiles: [],
                readmeOid: oid("5"),
              }),
            ]);
            expect(yield* f.get(50)).toMatchObject({
              ownerType: "org",
              ownerAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
            });

            yield* db.repos.saveIcon({ id: id(50), icon: null });
            yield* f.resummarize(50);
            expect(yield* f.enrich(50)).toMatchObject({ _tag: "Embedded" });
            expect(f.iconQueue.sent).toHaveLength(1);

            f.remotes.set(50, { description: "Icons", readme: { oid: oid("6"), text: "# Icons, renamed" } });
            yield* f.resummarize(50);
            expect(yield* f.enrich(50)).toMatchObject({ _tag: "Summarized" });
            expect(f.iconQueue.sent.at(-1)).toMatchObject({ repoId: id(50), readmeOid: oid("6") });
          }),
      );

      it.effect("queues icon work for a changed README even when the README read then fails the plan", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(51, { description: "Icons", readme: { oid: wideOid(5101), text: "# Icons" } });
          yield* f.enrich(51);
          yield* db.repos.saveIcon({ id: id(51), icon: null });
          f.iconQueue.sent.length = 0;

          f.remotes.set(51, { description: "Icons", readme: { oid: wideOid(5102), text: f.missingBlob } });
          yield* f.resummarize(51);
          expect(yield* f.enrich(51)).toMatchObject({ _tag: "Failed", error: { _tag: "NotFound" } });
          expect(f.iconQueue.sent).toEqual([expect.objectContaining({ repoId: id(51), readmeOid: wideOid(5102) })]);
        }),
      );

      it.effect("enriches a repo when the icon send fails, so an icon queue outage never holds up search", () =>
        Effect.gen(function* () {
          const failing = Layer.succeed(
            IconQueue.IconQueue,
            IconQueue.IconQueue.of({
              send: (messages) =>
                Effect.fail(new IconQueue.IconQueueFailed({ messages: messages.length, cause: null })),
            }),
          );
          f.remotes.set(52, { description: "Queue down", readme: { oid: wideOid(5201), text: "# Queue down" } });
          expect(
            yield* f.enrich(52).pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(failing)))),
          ).toMatchObject({ _tag: "Summarized" });
          expect(yield* f.get(52)).toMatchObject({ readmeOid: wideOid(5201), iconCheckedAt: null, embeddingModel });
        }),
      );

      it.effect("keeps a new summary when its embedding fails, then embeds it with no model call", () =>
        Effect.gen(function* () {
          f.remotes.set(8, { description: "Chat app", readme: { oid: oid("2"), text: "# Chat" } });
          expect(yield* f.enrich(8).pipe(f.using(f.failingEmbeddings))).toMatchObject({
            _tag: "Failed",
            error: { _tag: "AiRequestFailed" },
          });
          const kept = yield* f.get(8);
          expect(kept).toMatchObject({ summaryReadmeOid: oid("2"), embeddingModel: null });
          expect(kept.summary).toContain("Chat app");

          const calls = f.prompts.length;
          expect(yield* f.enrich(8)).toMatchObject({ _tag: "Embedded" });
          expect(f.prompts.length).toBe(calls);
        }),
      );

      it.effect("reports a stored repo with no node id and makes no GitHub call", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const { id: repoId, owner, name } = repo(9);
          yield* db.repos.saveFacts({
            id: repoId,
            owner,
            name,
            description: null,
            topics: [],
            language: null,
            license: null,
            homepage: null,
            createdAt: null,
            pushedAt: null,
            archived: false,
            readmeOid: null,
            ownerType: null,
            ownerAvatarUrl: null,
          });
          const sent = f.github.sent.length;
          expect(yield* f.enrichOne(repoId)).toEqual({ _tag: "NoNodeId", id: repoId });
          expect(f.github.sent.length).toBe(sent);
          expect(yield* f.failuresOf(9)).toEqual([{ enrich_failures: 1 }]);
        }),
      );

      it.effect("reports an id with no stored row as NotFound", () =>
        Effect.gen(function* () {
          expect(yield* f.enrichOne(id(10))).toEqual({ _tag: "NotFound", id: id(10) });
        }),
      );

      it.effect("reports NotFound when the row is deleted while its embedding is made", () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          f.remotes.set(12, { description: "Clock app", readme: { oid: oid("4"), text: "# Clock" } });
          const deleting = f.embeddingsWith((values) =>
            database.query("delete from repos where id = $1", [id(12)]).pipe(Effect.as(f.vectors(values))),
          );
          expect(yield* f.enrich(12).pipe(f.using(deleting))).toEqual({ _tag: "NotFound", id: id(12) });
        }),
      );

      it.effect("reports NotFound when the row is deleted while the model runs", () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          f.remotes.set(11, { description: "Note app", readme: { oid: oid("3"), text: "# Notes" } });
          const deleting = f.textGeneration((request) =>
            database
              .query("delete from repos where id = $1", [id(11)])
              .pipe(Effect.as({ output: SummarizeFake.respond(request.prompt), usage: f.usage })),
          );
          expect(yield* f.enrich(11).pipe(f.using(deleting))).toEqual({ _tag: "NotFound", id: id(11) });
        }),
      );
    },
  );

  const adapters = [
    ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
    ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
  ] as const;

  for (const [adapter, database] of adapters) {
    it.layer(f.enrichment(database), { timeout: 30_000 })(`enrichment guards on ${adapter}`, (it) => {
      it.effect("returns Stale when the README changes while a new summary is embedded", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(20, { description: "Video editor", readme: { oid: oid("4"), text: "# Editor" } });
          const moving = f.embeddingsWith((values) =>
            db.repos.get(id(20)).pipe(
              Effect.map(Option.getOrThrow),
              Effect.flatMap((row) => db.repos.saveFacts({ ...row, readmeOid: oid("5") })),
              Effect.orDie,
              Effect.as(f.vectors(values)),
            ),
          );
          expect(yield* f.enrich(20).pipe(f.using(moving))).toEqual({ _tag: "Stale", id: id(20) });
          expect(yield* f.get(20)).toMatchObject({
            readmeOid: oid("5"),
            summaryReadmeOid: oid("4"),
            embeddingModel: null,
          });
        }),
      );

      it.effect("returns Stale when the README changes while a stored summary is embedded again", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(21, { description: "Mail client", readme: { oid: oid("6"), text: "# Mail" } });
          yield* f.enrich(21);
          const row = yield* f.resummarize(21);
          const moving = f.embeddingsWith((values) =>
            db.repos.saveFacts({ ...row, readmeOid: oid("7") }).pipe(Effect.orDie, Effect.as(f.vectors(values))),
          );
          expect(yield* f.enrich(21).pipe(f.using(moving))).toEqual({ _tag: "Stale", id: id(21) });
          expect(yield* db.repos.pendingEnrichment([id(21)])).toEqual([id(21)]);
        }),
      );

      it.effect("returns Stale when another writer saved the same summary before the README moved", () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          f.remotes.set(22, { description: "Map app", readme: { oid: oid("8"), text: "# Maps" } });
          const racing = f.textGeneration((request) => {
            const summary = SummarizeFake.respond(request.prompt);
            return db.repos.get(id(22)).pipe(
              Effect.map(Option.getOrThrow),
              Effect.tap((row) =>
                summarize({
                  id: row.id,
                  readmeOid: oid("8"),
                  summary: summary.summary,
                  keywords: summary.keywords,
                }).pipe(Effect.provideService(Db.Db, db)),
              ),
              Effect.flatMap((row) => db.repos.saveFacts({ ...row, readmeOid: oid("9") })),
              Effect.orDie,
              Effect.as({ output: summary, usage: f.usage }),
            );
          });
          expect(yield* f.enrich(22).pipe(f.using(racing))).toEqual({ _tag: "Stale", id: id(22) });
          expect((yield* f.get(22)).embeddingModel).toBeNull();
        }),
      );

      it.effect("returns one outcome per input position, in input order, and enriches a duplicate once", () =>
        Effect.gen(function* () {
          for (const n of [1, 2, 3]) {
            f.remotes.set(n, { description: `Ordered ${n}`, readme: { oid: oid(String(n)), text: `# Ordered ${n}` } });
          }
          yield* f.store([1, 2, 3]);
          const calls = f.prompts.length;
          const input = [id(3), id(999), id(2), id(1), id(3)];
          const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(input);
          expect(outcomes.map((outcome): [number, string] => [outcome.id, outcome._tag])).toEqual([
            [3, "Summarized"],
            [999, "NotFound"],
            [2, "Summarized"],
            [1, "Summarized"],
            [3, "Summarized"],
          ]);
          const asked = f.prompts.slice(calls).map((prompt) => prompt.split("\n")[0]);
          expect(asked.filter((line) => line === "Repository: owner/repo-3")).toHaveLength(1);
        }),
      );

      it.effect("converges when a summary was saved without its embedding", () =>
        Effect.gen(function* () {
          f.remotes.set(23, { description: "Budget tracker", readme: { oid: oid("a"), text: "# Budget" } });
          yield* f.enrich(23).pipe(f.using(f.failingEmbeddings));
          expect(yield* f.enrich(23)).toMatchObject({ _tag: "Embedded", id: id(23) });
          expect(yield* f.enrich(23)).toEqual({ _tag: "Unchanged", id: id(23) });
        }),
      );
    });
  }
}

{
  const f = fixture();

  it.layer(f.enrichment(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })("enrichRepos", (it) => {
    it.effect(
      "enriches a batch, reports each outcome in input order, and neither summarizes nor looks up anything twice on a rerun",
      () =>
        Effect.gen(function* () {
          for (const n of [30, 31, 32, 34]) {
            f.remotes.set(n, { description: `Tool ${n}`, readme: { oid: oid(String(n % 10)), text: `# Tool ${n}` } });
          }
          const batch = [...(yield* f.store([34, 33, 32, 31, 30])), id(35)];
          const enricher = yield* EnrichRepo.EnrichRepo;
          expect(
            (yield* enricher.enrichRepos(batch)).map((outcome): [number, string] => [outcome.id, outcome._tag]),
          ).toEqual([
            [34, "Failed"],
            [33, "Gone"],
            [32, "Summarized"],
            [31, "Summarized"],
            [30, "Summarized"],
            [35, "NotFound"],
          ]);

          const calls = f.prompts.length;
          expect((yield* enricher.enrichRepos(batch)).map((outcome) => outcome._tag)).toEqual([
            "Backoff",
            "Backoff",
            "Unchanged",
            "Unchanged",
            "Unchanged",
            "NotFound",
          ]);
          expect(f.prompts.slice(calls)).toEqual([]);
        }),
    );

    it.effect(
      "logs each failed repo's ID, its failure's tag, and whether it counts, and never the README or answer",
      () =>
        Effect.gen(function* () {
          f.remotes.set(300, { description: "Tool 300", readme: { oid: oid("5"), text: "# Secret README words" } });
          const invalid = f.textGeneration(() =>
            Effect.succeed({ output: { summary: "Secret answer words", keywords: "not a list" }, usage: f.usage }),
          );
          const logs: Array<unknown> = [];
          const batch = yield* f.store([300, 301]);
          yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(batch)).pipe(
            f.using(invalid),
            Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
          );
          expect(logs.filter((message) => Array.isArray(message) && message[0] === "Enrichment failed")).toEqual([
            ["Enrichment failed", { repoId: 301, error: "Gone", counts: true }],
            [
              "Enrichment failed",
              {
                repoId: 300,
                error: "AiOutputInvalid",
                counts: true,
                detail:
                  "Model 'test/text' returned output that does not match the expected shape in 'generate': structured output does not match the schema",
              },
            ],
          ]);
          expect(JSON.stringify(logs)).not.toContain("Secret");
        }),
    );

    it.effect("enriches the rest of a batch when GitHub forbids one of its repos", () =>
      Effect.gen(function* () {
        const numbers = Array.from({ length: 100 }, (_, i) => 100 + i);
        for (const n of numbers) f.remotes.set(n, { description: `Starred ${n}`, forbidden: n === 130 });
        const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(yield* f.store(numbers));
        expect(outcomes.map((outcome): [number, string] => [outcome.id, outcome._tag])).toEqual(
          numbers.map((n): [number, string] => [n, n === 130 ? "Gone" : "Summarized"]),
        );
      }),
    );

    it.effect("counts a failure each time GitHub forbids a repo, and clears the count once the repo is read", () =>
      Effect.gen(function* () {
        f.remotes.set(240, { description: "Private now", forbidden: true });
        f.remotes.set(241, { description: "Public" });
        const enricher = yield* EnrichRepo.EnrichRepo;
        const batch = yield* f.store([240, 241]);
        yield* TestClock.setTime(Date.parse("2026-11-05T12:00:00Z"));
        expect((yield* enricher.enrichRepos(batch)).map((outcome) => outcome._tag)).toEqual(["Gone", "Summarized"]);
        yield* TestClock.adjust("10 minutes");
        expect((yield* enricher.enrichRepos(batch)).map((outcome) => outcome._tag)).toEqual(["Gone", "Unchanged"]);
        const database = yield* TestDatabase.TestDatabase;
        const stored = () =>
          database.query(
            "select id::int, enrich_failures, enrich_retry_at::text as retry_at from repos where id = any($1) order by id",
            [[240, 241]],
          );
        expect(yield* stored()).toEqual([
          { id: 240, enrich_failures: 2, retry_at: expect.stringContaining("2026-11-05 13:10:00") },
          { id: 241, enrich_failures: 0, retry_at: null },
        ]);

        f.remotes.set(240, { description: "Public again" });
        yield* TestClock.adjust("1 hour");
        expect((yield* enricher.enrichRepos([id(240)])).map((outcome) => outcome._tag)).toEqual(["Summarized"]);
        expect(yield* stored()).toEqual([
          { id: 240, enrich_failures: 0, retry_at: null },
          { id: 241, enrich_failures: 0, retry_at: null },
        ]);
      }),
    );

    it.effect(
      "skips a repo in its backoff with no GitHub call and no new failure, and tries it once the delay passes",
      () =>
        Effect.gen(function* () {
          f.remotes.set(250, { description: "Private now", forbidden: true });
          const enricher = yield* EnrichRepo.EnrichRepo;
          const batch = yield* f.store([250]);
          const lookups = () => f.github.sent.filter((sent) => sent.url.pathname === "/graphql").length;
          const tags = Effect.map(enricher.enrichRepos(batch), (outcomes) => outcomes.map((outcome) => outcome._tag));
          yield* TestClock.setTime(Date.parse("2026-11-06T12:00:00Z"));

          const tries: Array<[string, ReadonlyArray<string>, number]> = [];
          const attempt = (label: string) =>
            Effect.gen(function* () {
              const before = lookups();
              tries.push([label, yield* tags, lookups() - before]);
            });
          yield* attempt("first try");
          yield* attempt("a queue retry a minute later");
          yield* TestClock.adjust("10 minutes");
          yield* attempt("the sweep 10 minutes after the first failure");
          yield* TestClock.adjust("59 minutes");
          yield* attempt("a copy 59 minutes after the second failure");
          yield* TestClock.adjust("1 minute");
          yield* attempt("the sweep an hour after the second failure");
          yield* attempt("a full sync after the cap");

          expect(tries).toEqual([
            ["first try", ["Gone"], 1],
            ["a queue retry a minute later", ["Backoff"], 0],
            ["the sweep 10 minutes after the first failure", ["Gone"], 1],
            ["a copy 59 minutes after the second failure", ["Backoff"], 0],
            ["the sweep an hour after the second failure", ["Gone"], 1],
            ["a full sync after the cap", ["Gone"], 1],
          ]);
          expect(yield* f.failuresOf(250)).toEqual([{ enrich_failures: 4 }]);
        }),
    );

    it.effect("counts no failure when enrichment fails for a reason every repo shares", () =>
      Effect.gen(function* () {
        for (const n of [270, 271]) f.remotes.set(n, { description: `Shared outage ${n}` });
        const batch = yield* f.store([270, 271]);
        const enrichWith = <ROut, E>(layer: Layer.Layer<ROut, E>) =>
          Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(batch)).pipe(
            Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(layer))),
          );
        const counts = () => Effect.map(Effect.all([f.failuresOf(270), f.failuresOf(271)]), (rows) => rows.flat());
        const untouched = [{ enrich_failures: 0 }, { enrich_failures: 0 }];

        const tokenMissing = Layer.mock(GitHub.GitHub, {
          repoFacts: () => Effect.fail(new GitHubTokenMissing({ operation: "repo-facts" })),
        });
        expect((yield* Effect.flip(enrichWith(tokenMissing)))._tag).toBe("GitHubTokenMissing");
        expect(yield* counts()).toEqual(untouched);

        const keyMissing = Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.make({
            provider: "test",
            model: "test/text",
            timeout: Duration.seconds(5),
            run: () => Effect.fail(new AiKeyMissing({ operation: "generate", model: "test/text" })),
          }),
        );
        expect((yield* enrichWith(keyMissing)).map((outcome) => outcome._tag)).toEqual(["Failed", "Failed"]);
        expect(yield* counts()).toEqual(untouched);

        expect((yield* enrichWith(f.failingEmbeddings)).map((outcome) => outcome._tag)).toEqual(["Failed", "Failed"]);
        expect(yield* counts()).toEqual(untouched);

        expect((yield* enrichWith(f.wrongSizeEmbeddings)).map((outcome) => outcome._tag)).toEqual(["Failed", "Failed"]);
        expect(yield* counts()).toEqual(untouched);

        const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(batch);
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Embedded", "Embedded"]);
      }),
    );

    it.effect("marks a repo Failed when its README cannot be read", () =>
      Effect.gen(function* () {
        f.remotes.set(37, { description: "Lost README", readme: { oid: oid("7"), text: f.missingBlob } });
        const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(yield* f.store([37]));
        expect(outcomes).toMatchObject([{ _tag: "Failed", id: id(37), error: { _tag: "NotFound" } }]);
      }),
    );

    it.effect("answers every repo directly when the whole batch job fails", () =>
      Effect.gen(function* () {
        f.remotes.set(38, { description: "Recipe app", readme: { oid: oid("8"), text: "# Recipes" } });
        f.remotes.set(39, { description: "Menu app", readme: { oid: wideOid(39), text: "# Menus" } });
        let direct = 0;
        let batches = 0;
        const failingBatch = Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.make({
            provider: "test",
            model: "test/text",
            timeout: Duration.seconds(5),
            run: (request) =>
              Effect.sync(() => {
                direct++;
                return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
              }),
            batch: {
              timeout: Duration.hours(1),
              run: () =>
                Effect.suspend(() => {
                  batches++;
                  return Effect.fail(
                    new AiRequestFailed({ operation: "generate", model: "test/text", detail: "failed" }),
                  );
                }),
            },
          }),
        );
        const ids = yield* f.store([38, 39]);
        const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids)).pipe(
          f.using(failingBatch),
        );
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Summarized", "Summarized"]);
        expect({ batches, direct }).toEqual({ batches: 1, direct: 2 });
      }),
    );

    it.effect("leaves a repo pending without counting a failure when the model is unavailable", () =>
      Effect.gen(function* () {
        f.remotes.set(36, { description: "Photo app", readme: { oid: oid("6"), text: "# Photos" } });
        const unavailable = f.textGeneration(() =>
          Effect.fail(new AiUnavailable({ operation: "generate", model: "test/text", detail: "503" })),
        );
        const ids = yield* f.store([36]);
        const enrichAll = Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids));
        expect(yield* enrichAll.pipe(f.using(unavailable))).toMatchObject([
          { _tag: "Failed", error: { _tag: "AiUnavailable" } },
        ]);
        expect(yield* f.failuresOf(36)).toEqual([{ enrich_failures: 0 }]);
        expect(yield* enrichAll).toMatchObject([{ _tag: "Summarized" }]);
      }),
    );

    it.effect("caps a repo the model refuses, so neither the queue nor the sweep asks it again", () =>
      Effect.gen(function* () {
        f.remotes.set(41, { description: "Remote access tool", readme: { oid: wideOid(41), text: "# RAT" } });
        let calls = 0;
        const refusing = f.textGeneration(() =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(
              new AiRefused({ operation: "generate", model: "test/text", detail: "finish reason content-filter" }),
            );
          }),
        );
        const ids = yield* f.store([41]);
        const enrichAll = Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids));
        expect(yield* enrichAll.pipe(f.using(refusing))).toMatchObject([
          { _tag: "Failed", error: { _tag: "AiRefused" } },
        ]);
        expect(yield* f.failuresOf(41)).toEqual([{ enrich_failures: Db.enrichFailureCap }]);
        expect(EnrichRepo.ownError(new AiRefused({ operation: "generate", model: "m", detail: "d" }))).toBe(true);

        yield* TestClock.adjust("2 hours");
        const queue = EnrichQueue.layerMemory();
        yield* EnrichRetry.sweep().pipe(Effect.provide(queue.layer));
        expect(queue.sent.filter((message) => Number(message.repoId) === 41)).toEqual([]);
        expect(calls).toBe(1);
      }),
    );
    it.effect(
      "saves each summary as its answer arrives, so a run cut short keeps them and the next run only embeds them",
      () =>
        Effect.gen(function* () {
          const numbers = [280, 281, 282];
          for (const n of numbers)
            f.remotes.set(n, { description: `Slow ${n}`, readme: { oid: wideOid(n), text: `# Slow ${n}` } });
          const db = yield* Db.Db;
          const saved = yield* Queue.unbounded<RepoId>();
          const watched = Layer.succeed(
            Db.Db,
            Db.Db.of({
              ...db,
              knowledge: {
                ...db.knowledge,
                capture: (answers) =>
                  Effect.tap(db.knowledge.capture(answers), () =>
                    Effect.forEach(answers, (answer) => Queue.offer(saved, answer.repoId)),
                  ),
              },
            }),
          );
          const allAsked = yield* Deferred.make<void>();
          const asked: Array<string> = [];
          const answerAfter = (seconds: (prompt: string) => number) =>
            f.textGeneration((request) =>
              Effect.gen(function* () {
                asked.push(request.prompt);
                if (asked.length === numbers.length) yield* Deferred.succeed(allAsked, undefined);
                yield* Effect.sleep(Duration.seconds(seconds(request.prompt)));
                return { output: SummarizeFake.respond(request.prompt), usage: f.usage };
              }),
            );
          const slow = answerAfter((prompt) =>
            prompt.includes("repo-280\n") ? 1 : prompt.includes("repo-281\n") ? 2 : 4,
          );
          const ids = yield* f.store(numbers);
          const enrichAll = Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids));

          const fiber = yield* Effect.forkChild(
            enrichAll.pipe(
              Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(Layer.merge(watched, slow)))),
            ),
          );
          yield* Deferred.await(allAsked);
          yield* TestClock.adjust("1 second");
          expect(yield* Queue.take(saved)).toBe(id(280));
          yield* TestClock.adjust("1 second");
          expect(yield* Queue.take(saved)).toBe(id(281));
          yield* Fiber.interrupt(fiber);
          expect(yield* f.get(281)).toMatchObject({ summaryReadmeOid: wideOid(281), embeddingModel: null });
          expect((yield* f.get(282)).summary).toBeNull();

          // The repo whose call was cut short stays leased, so nothing pays for it again until the lease runs out.
          asked.length = 0;
          const outcomes = yield* enrichAll.pipe(f.using(answerAfter(() => 0)));
          expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Embedded", "Embedded", "Backoff"]);
          expect(asked).toEqual([]);

          yield* TestClock.adjust(EnrichRetry.attemptLease);
          const later = yield* enrichAll.pipe(f.using(answerAfter(() => 0)));
          expect(later.map((outcome) => outcome._tag)).toEqual(["Unchanged", "Unchanged", "Summarized"]);
          expect(asked).toEqual([expect.stringContaining("Repository: owner/repo-282\n")]);
        }),
    );
    it.effect("saves a later answer while an earlier summary's save still waits", () =>
      Effect.gen(function* () {
        const numbers = [283, 284];
        for (const n of numbers)
          f.remotes.set(n, { description: `Locked ${n}`, readme: { oid: wideOid(n), text: `# ${n}` } });
        const db = yield* Db.Db;
        const saved = yield* Queue.unbounded<RepoId>();
        const unlock = yield* Deferred.make<void>();
        const locked = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              capture: (answers) =>
                Effect.andThen(
                  answers.some((answer) => answer.repoId === id(283)) ? Deferred.await(unlock) : Effect.void,
                  Effect.tap(db.knowledge.capture(answers), () =>
                    Effect.forEach(answers, (answer) => Queue.offer(saved, answer.repoId)),
                  ),
                ),
            },
          }),
        );
        const ids = yield* f.store(numbers);
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids)).pipe(
            Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(locked))),
          ),
        );
        expect(yield* Queue.take(saved)).toBe(id(284));
        yield* Deferred.succeed(unlock, undefined);
        expect((yield* Fiber.join(fiber)).map((outcome) => outcome._tag)).toEqual(["Summarized", "Summarized"]);
      }),
    );
    it.effect("reads up to four READMEs from the blob store at once while it plans", () =>
      Effect.gen(function* () {
        const numbers = [60, 61, 62, 63, 64, 65, 66, 67];
        for (const n of numbers) {
          f.remotes.set(n, {
            description: `Planned ${n}`,
            readme: { oid: wideOid(n), text: `# Planned ${n}` },
          });
        }
        const fourWaiting = yield* Deferred.make<void>();
        const reads = { inFlight: 0, peak: 0 };
        const slowBlobs = Layer.effect(
          BlobStore.BlobStore,
          Effect.map(BlobStore.BlobStore, (blobs) =>
            BlobStore.BlobStore.of({
              get: (key) =>
                Effect.gen(function* () {
                  reads.inFlight++;
                  reads.peak = Math.max(reads.peak, reads.inFlight);
                  if (reads.inFlight === 4) yield* Deferred.succeed(fourWaiting, undefined);
                  yield* Deferred.await(fourWaiting);
                  reads.inFlight--;
                  return yield* blobs.get(key);
                }),
              put: blobs.put,
            }),
          ),
        ).pipe(Layer.provide(BlobStore.layerMemory));
        const ids = yield* f.store(numbers);
        const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids)).pipe(
          Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(slowBlobs))),
        );
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(numbers.map(() => "Summarized"));
        expect(reads.peak).toBe(4);
      }),
    );
    it.effect("starts the backoff when GitHub answers, so a wait at the token gate does not shorten it", () =>
      Effect.gen(function* () {
        const ids = yield* f.store([260]);
        const slowGitHub = Layer.mock(GitHub.GitHub, {
          repoFacts: () => Effect.sleep("15 minutes").pipe(Effect.as([])),
        });
        yield* TestClock.setTime(Date.parse("2026-11-07T12:00:00Z"));
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids)).pipe(
            Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(slowGitHub))),
          ),
        );
        yield* TestClock.adjust("15 minutes");
        expect((yield* Fiber.join(fiber)).map((outcome) => outcome._tag)).toEqual(["Gone"]);
        const stored = yield* Effect.flatMap(TestDatabase.TestDatabase, (database) =>
          database.query("select enrich_retry_at::text as retry_at from repos where id = 260"),
        );
        expect(stored).toEqual([{ retry_at: expect.stringContaining("2026-11-07 12:25:00") }]);
      }),
    );
  });
}
