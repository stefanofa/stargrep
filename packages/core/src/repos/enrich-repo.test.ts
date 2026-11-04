import { describe, expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import { AiRequestFailed, AiUnavailable } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId, Repo } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRepo from "./enrich-repo.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const oid = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
const wideOid = (n: number) => Schema.decodeSync(ObjectId)(String(n).padStart(40, "b"));
const repo = (n: number) => Schema.decodeSync(Repo)({ id: n, nodeId: `R_${n}`, owner: "owner", name: `repo-${n}` });
const id = (n: number) => repo(n).id;

interface Remote {
  readonly description: string | null;
  readonly archived?: boolean;
  readonly readme?: { readonly oid: ObjectId; readonly text: string };
}

const remotes = new Map<number, Remote>();
const missingBlob = "\u0000missing";

const node = (n: number, remote: Remote) => ({
  databaseId: n,
  id: `R_${n}`,
  name: `repo-${n}`,
  owner: { login: "owner" },
  description: remote.description,
  homepageUrl: `https://repo-${n}.dev`,
  primaryLanguage: { name: "Rust" },
  licenseInfo: { spdxId: "MIT" },
  repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
  createdAt: "2020-01-01T00:00:00Z",
  pushedAt: "2026-10-01T00:00:00Z",
  isArchived: remote.archived ?? false,
  isFork: false,
  stargazerCount: 10,
  forkCount: 1,
  root: { entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: remote.readme.oid }] },
});

const github = GitHubFake.layer((sent) => {
  if (sent.url.pathname === "/graphql") {
    const ids: ReadonlyArray<string> = JSON.parse(sent.body ?? "{}").variables.ids;
    const nodes = ids.map((nodeId) => {
      const n = Number(nodeId.slice(2));
      const remote = remotes.get(n);
      return remote === undefined ? null : node(n, remote);
    });
    return { body: { data: { nodes } } };
  }
  const blob = sent.url.pathname.split("/").at(-1);
  const remote = [...remotes.values()].find((entry) => entry.readme?.oid === blob);
  return remote?.readme === undefined || remote.readme.text === missingBlob
    ? { status: 404 }
    : { body: remote.readme.text };
});

const readmeRequests = () => github.sent.filter((sent) => sent.url.pathname.includes("/git/blobs/")).length;

const prompts: Array<string> = [];
const respond = (prompt: string) => {
  prompts.push(prompt);
  return prompt.includes("Repository: owner/repo-34\n")
    ? { summary: "", keywords: [], kind: "app" }
    : SummarizeFake.respond(prompt);
};

const usage = { inputTokens: 1, outputTokens: 1 };

const textGeneration = (
  run: (request: TextGeneration.RunRequest) => Effect.Effect<TextGeneration.RunResult, AiUnavailable>,
) =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({ provider: "test", model: "test/text", timeout: Duration.seconds(5), run }),
  );

const embeddingsWith = (
  run: (values: ReadonlyArray<string>) => Effect.Effect<Embeddings.EmbedResult, AiRequestFailed>,
) =>
  Layer.succeed(
    Embeddings.Embeddings,
    Embeddings.make({
      provider: "test",
      model: { id: embeddingModel, dimensions: 1024 },
      timeout: Duration.seconds(5),
      run,
    }),
  );

const failingEmbeddings = embeddingsWith(() =>
  Effect.fail(new AiRequestFailed({ operation: "embed", model: embeddingModel, detail: "bad request" })),
);

const vectors = (values: ReadonlyArray<string>) => ({
  vectors: values.map(() => Array.from({ length: 1024 }, (_, at) => (at === 0 ? 1 : 0))),
  tokens: values.length,
});

const enrichment = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
  Layer.provideMerge(
    EnrichRepo.layer,
    Layer.mergeAll(
      database,
      github.layer,
      BlobStore.layerMemory,
      Fake.layerTextGeneration(respond),
      Fake.layerEmbeddings(),
    ),
  );

const using = <ROut extends TextGeneration.TextGeneration | Embeddings.Embeddings>(model: Layer.Layer<ROut>) =>
  Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(model)));

const store = Effect.fn("test.store")(function* (numbers: ReadonlyArray<number>) {
  const db = yield* Db.Db;
  const refs = numbers.map(repo);
  yield* db.repos.upsertRefs(refs);
  return refs.map((ref) => ref.id);
});

const enrich = (n: number) =>
  Effect.gen(function* () {
    yield* store([n]);
    return yield* (yield* EnrichRepo.EnrichRepo).enrichRepo(id(n));
  });

const get = (n: number) => Effect.flatMap(Db.Db, (db) => Effect.map(db.repos.get(id(n)), Option.getOrThrow));

const resummarize = (n: number) =>
  Effect.gen(function* () {
    const db = yield* Db.Db;
    const row = yield* get(n);
    yield* db.repos.saveSummary({
      id: row.id,
      readmeOid: row.readmeOid,
      summary: row.summary ?? "",
      keywords: row.keywords,
      kind: row.kind ?? "",
    });
    return row;
  });

it.layer(enrichment(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })("enrichRepo", (it) => {
  it.effect("stores facts, the README blob, the summary, and its embedding for a new repo", () =>
    Effect.gen(function* () {
      remotes.set(1, {
        description: "Fast log parser",
        archived: true,
        readme: { oid: oid("a"), text: "# Parser\n\n![logo](logo.png)\n\nParses web server logs." },
      });
      expect(yield* enrich(1)).toMatchObject({ _tag: "Summarized", id: id(1) });

      const db = yield* Db.Db;
      const stored = yield* get(1);
      expect(stored).toMatchObject({
        license: "MIT",
        homepage: "https://repo-1.dev",
        archived: true,
        readmeOid: oid("a"),
        summaryReadmeOid: oid("a"),
        embeddingModel,
      });
      expect(stored.summary).toContain("Parses web server logs.");
      expect(prompts.at(-1)).not.toContain("logo.png");
      const blobs = yield* BlobStore.BlobStore;
      expect(Option.getOrThrow(yield* blobs.get(EnrichRepo.readmeKey(oid("a"))))).toContain("![logo](logo.png)");
      expect(yield* db.repos.pendingEnrichment([id(1)])).toEqual([]);
    }),
  );

  it.effect("skips a repo whose README did not change, with no GitHub or model call", () =>
    Effect.gen(function* () {
      remotes.set(2, { description: "Terminal UI", readme: { oid: oid("b"), text: "# TUI" } });
      yield* enrich(2);
      const [sent, calls] = [github.sent.length, prompts.length];
      expect(yield* enrich(2)).toEqual({ _tag: "Unchanged", id: id(2) });
      expect([github.sent.length, prompts.length]).toEqual([sent, calls]);
    }),
  );

  it.effect("summarizes again once the stored README object ID changes", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(3, { description: "Sync tool", readme: { oid: oid("c"), text: "# Old\n\nSyncs folders." } });
      yield* enrich(3);
      remotes.set(3, { description: "Sync tool", readme: { oid: oid("d"), text: "# New\n\nSyncs phones." } });
      yield* db.repos.saveFacts({ ...(yield* get(3)), readmeOid: oid("d") });

      expect(yield* enrich(3)).toMatchObject({ _tag: "Summarized" });
      const after = yield* get(3);
      expect(after.summaryReadmeOid).toBe(oid("d"));
      expect(after.summary).toContain("Syncs phones.");
      expect(after.embeddingModel).toBe(embeddingModel);
    }),
  );

  it.effect("skips a repo when GitHub reports the README its summary came from, whatever oid was stored", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(6, { description: "Backup tool", readme: { oid: oid("c"), text: "# Backup" } });
      yield* enrich(6);
      yield* db.repos.saveFacts({ ...(yield* get(6)), readmeOid: oid("d") });
      expect(yield* db.repos.pendingEnrichment([id(6)])).toEqual([id(6)]);

      const [readmes, calls] = [readmeRequests(), prompts.length];
      expect(yield* enrich(6)).toEqual({ _tag: "Unchanged", id: id(6) });
      expect([readmeRequests(), prompts.length]).toEqual([readmes, calls]);
      expect(yield* get(6)).toMatchObject({ readmeOid: oid("c"), summaryReadmeOid: oid("c"), embeddingModel });
    }),
  );

  it.effect("keeps README text and the summary made from it out of every span", () => {
    const collected = collectSpans();
    return Effect.gen(function* () {
      const canary = "PRIVATE_README_CANARY";
      remotes.set(13, { description: "Notes app", readme: { oid: oid("0"), text: `# Notes\n\n${canary} sync.` } });
      expect(yield* enrich(13)).toMatchObject({ _tag: "Summarized" });
      expect(yield* enrich(13)).toEqual({ _tag: "Unchanged", id: id(13) });
      expect((yield* get(13)).summary).toContain(canary);

      const names = new Set(collected.spans.map((span) => span.name));
      for (const name of ["EnrichRepo.enrichRepo", "GitHub.readme", "TokenGate.execute", "Db.repos.getMany"]) {
        expect(names).toContain(name);
      }
      expect(collected.text()).not.toContain(canary);
    }).pipe(Effect.withTracer(collected.tracer));
  });

  it.effect("summarizes a repo with no README from its description", () =>
    Effect.gen(function* () {
      remotes.set(4, { description: "Dotfiles for macOS" });
      const readmes = readmeRequests();
      const outcome = yield* enrich(4);
      expect(outcome._tag === "Summarized" && outcome.summary.summary).toStartWith("Dotfiles for macOS");
      expect(prompts.at(-1)).toContain("README:\nnone");
      expect(readmeRequests()).toBe(readmes);
    }),
  );

  it.effect("keeps facts and leaves the repo pending when the model output is invalid", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(5, { description: "Image viewer", readme: { oid: oid("e"), text: "# Viewer" } });
      const invalid = textGeneration(() => Effect.succeed({ output: { summary: "" }, usage }));
      const failed = yield* Effect.exit(enrich(5).pipe(using(invalid)));
      expect(Exit.findErrorOption(failed).pipe(Option.map((error) => error._tag))).toEqual(
        Option.some("AiOutputInvalid"),
      );
      expect(Exit.isFailure(failed) && Cause.pretty(failed.cause)).toContain("at EnrichRepo.enrichRepo (definition)");
      expect(yield* get(5)).toMatchObject({ license: "MIT", readmeOid: oid("e"), summary: null, embeddingModel: null });
      expect(yield* db.repos.pendingEnrichment([id(5)])).toEqual([id(5)]);

      const readmes = readmeRequests();
      expect(yield* enrich(5)).toMatchObject({ _tag: "Summarized" });
      expect(readmeRequests()).toBe(readmes);
    }),
  );

  it.effect("embeds a stored summary again without a model call when its embedding is missing", () =>
    Effect.gen(function* () {
      remotes.set(7, { description: "HTTP client", readme: { oid: oid("1"), text: "# Client" } });
      yield* enrich(7);
      yield* resummarize(7);
      const calls = prompts.length;
      expect(yield* enrich(7)).toMatchObject({ _tag: "Embedded" });
      expect(prompts.length).toBe(calls);
      expect((yield* get(7)).embeddingModel).toBe(embeddingModel);
    }),
  );

  it.effect("keeps a new summary when its embedding fails, then embeds it with no model call", () =>
    Effect.gen(function* () {
      remotes.set(8, { description: "Chat app", readme: { oid: oid("2"), text: "# Chat" } });
      expect((yield* Effect.flip(enrich(8).pipe(using(failingEmbeddings))))._tag).toBe("AiRequestFailed");
      const kept = yield* get(8);
      expect(kept).toMatchObject({ summaryReadmeOid: oid("2"), embeddingModel: null });
      expect(kept.summary).toContain("Chat app");

      const calls = prompts.length;
      expect(yield* enrich(8)).toMatchObject({ _tag: "Embedded" });
      expect(prompts.length).toBe(calls);
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
      });
      const sent = github.sent.length;
      expect(yield* (yield* EnrichRepo.EnrichRepo).enrichRepo(repoId)).toEqual({ _tag: "NoNodeId", id: repoId });
      expect(github.sent.length).toBe(sent);
    }),
  );

  it.effect("reports an id with no stored row as NotFound", () =>
    Effect.gen(function* () {
      expect(yield* (yield* EnrichRepo.EnrichRepo).enrichRepo(id(10))).toEqual({ _tag: "NotFound", id: id(10) });
    }),
  );

  it.effect("reports NotFound when the row is deleted while its embedding is made", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      remotes.set(12, { description: "Clock app", readme: { oid: oid("4"), text: "# Clock" } });
      const deleting = embeddingsWith((values) =>
        database.query("delete from repos where id = $1", [id(12)]).pipe(Effect.as(vectors(values))),
      );
      expect(yield* enrich(12).pipe(using(deleting))).toEqual({ _tag: "NotFound", id: id(12) });
    }),
  );

  it.effect("reports NotFound when the row is deleted while the model runs", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      remotes.set(11, { description: "Note app", readme: { oid: oid("3"), text: "# Notes" } });
      const deleting = textGeneration((request) =>
        database
          .query("delete from repos where id = $1", [id(11)])
          .pipe(Effect.as({ output: SummarizeFake.respond(request.prompt), usage })),
      );
      expect(yield* enrich(11).pipe(using(deleting))).toEqual({ _tag: "NotFound", id: id(11) });
    }),
  );
});

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

for (const [adapter, database] of adapters) {
  it.layer(enrichment(database), { timeout: 30_000 })(`enrichment guards on ${adapter}`, (it) => {
    it.effect("returns Stale when the README changes while a new summary is embedded", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        remotes.set(20, { description: "Video editor", readme: { oid: oid("4"), text: "# Editor" } });
        const moving = embeddingsWith((values) =>
          db.repos.get(id(20)).pipe(
            Effect.map(Option.getOrThrow),
            Effect.flatMap((row) => db.repos.saveFacts({ ...row, readmeOid: oid("5") })),
            Effect.orDie,
            Effect.as(vectors(values)),
          ),
        );
        expect(yield* enrich(20).pipe(using(moving))).toEqual({ _tag: "Stale", id: id(20) });
        expect(yield* get(20)).toMatchObject({ readmeOid: oid("5"), summaryReadmeOid: oid("4"), embeddingModel: null });
      }),
    );

    it.effect("returns Stale when the README changes while a stored summary is embedded again", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        remotes.set(21, { description: "Mail client", readme: { oid: oid("6"), text: "# Mail" } });
        yield* enrich(21);
        const row = yield* resummarize(21);
        const moving = embeddingsWith((values) =>
          db.repos.saveFacts({ ...row, readmeOid: oid("7") }).pipe(Effect.orDie, Effect.as(vectors(values))),
        );
        expect(yield* enrich(21).pipe(using(moving))).toEqual({ _tag: "Stale", id: id(21) });
        expect((yield* get(21)).embeddingModel).toBeNull();
      }),
    );

    it.effect("returns Stale when another writer saved the same summary before the README moved", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        remotes.set(22, { description: "Map app", readme: { oid: oid("8"), text: "# Maps" } });
        const racing = textGeneration((request) => {
          const summary = SummarizeFake.respond(request.prompt);
          return db.repos.get(id(22)).pipe(
            Effect.map(Option.getOrThrow),
            Effect.tap((row) => db.repos.saveSummary({ id: row.id, readmeOid: oid("8"), ...summary })),
            Effect.flatMap((row) => db.repos.saveFacts({ ...row, readmeOid: oid("9") })),
            Effect.orDie,
            Effect.as({ output: summary, usage }),
          );
        });
        expect(yield* enrich(22).pipe(using(racing))).toEqual({ _tag: "Stale", id: id(22) });
        expect((yield* get(22)).embeddingModel).toBeNull();
      }),
    );

    it.effect("returns one outcome per input position, in input order, and enriches a duplicate once", () =>
      Effect.gen(function* () {
        for (const n of [1, 2, 3]) {
          remotes.set(n, { description: `Ordered ${n}`, readme: { oid: oid(String(n)), text: `# Ordered ${n}` } });
        }
        yield* store([1, 2, 3]);
        const calls = prompts.length;
        const input = [id(3), id(999), id(2), id(1), id(3)];
        const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(input, "batch");
        expect(outcomes.map((outcome): [number, string] => [outcome.id, outcome._tag])).toEqual([
          [3, "Summarized"],
          [999, "NotFound"],
          [2, "Summarized"],
          [1, "Summarized"],
          [3, "Summarized"],
        ]);
        const asked = prompts.slice(calls).map((prompt) => prompt.split("\n")[0]);
        expect(asked.filter((line) => line === "Repository: owner/repo-3")).toHaveLength(1);
      }),
    );

    it.effect("converges when a summary was saved without its embedding", () =>
      Effect.gen(function* () {
        remotes.set(23, { description: "Budget tracker", readme: { oid: oid("a"), text: "# Budget" } });
        yield* Effect.flip(enrich(23).pipe(using(failingEmbeddings)));
        expect(yield* enrich(23)).toMatchObject({ _tag: "Embedded", id: id(23) });
        expect(yield* enrich(23)).toEqual({ _tag: "Unchanged", id: id(23) });
      }),
    );
  });
}

it.layer(enrichment(TestDatabase.layerMemory({ embeddingModel })), { timeout: 30_000 })("enrichRepos", (it) => {
  it.effect("enriches a batch, reports each outcome in input order, and summarizes nothing twice on a rerun", () =>
    Effect.gen(function* () {
      for (const n of [30, 31, 32, 34]) {
        remotes.set(n, { description: `Tool ${n}`, readme: { oid: oid(String(n % 10)), text: `# Tool ${n}` } });
      }
      const batch = [...(yield* store([34, 33, 32, 31, 30])), id(35)];
      const enricher = yield* EnrichRepo.EnrichRepo;
      expect(
        (yield* enricher.enrichRepos(batch, "batch")).map((outcome): [number, string] => [outcome.id, outcome._tag]),
      ).toEqual([
        [34, "Failed"],
        [33, "Gone"],
        [32, "Summarized"],
        [31, "Summarized"],
        [30, "Summarized"],
        [35, "NotFound"],
      ]);

      const calls = prompts.length;
      expect((yield* enricher.enrichRepos(batch, "batch")).map((outcome) => outcome._tag)).toEqual([
        "Failed",
        "Gone",
        "Unchanged",
        "Unchanged",
        "Unchanged",
        "NotFound",
      ]);
      expect(prompts.slice(calls).map((prompt) => prompt.split("\n")[0])).toEqual(["Repository: owner/repo-34"]);
    }),
  );

  it.effect("marks a repo Failed when its README cannot be read", () =>
    Effect.gen(function* () {
      remotes.set(37, { description: "Lost README", readme: { oid: oid("7"), text: missingBlob } });
      const outcomes = yield* (yield* EnrichRepo.EnrichRepo).enrichRepos(yield* store([37]), "batch");
      expect(outcomes).toMatchObject([{ _tag: "Failed", id: id(37), error: { _tag: "NotFound" } }]);
    }),
  );

  it.effect("answers every repo directly when the whole batch job fails", () =>
    Effect.gen(function* () {
      remotes.set(38, { description: "Recipe app", readme: { oid: oid("8"), text: "# Recipes" } });
      let direct = 0;
      const failingBatch = Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.make({
          provider: "test",
          model: "test/text",
          timeout: Duration.seconds(5),
          run: (request) =>
            Effect.sync(() => {
              direct++;
              return { output: SummarizeFake.respond(request.prompt), usage };
            }),
          batch: {
            timeout: Duration.hours(1),
            run: () =>
              Effect.fail(new AiRequestFailed({ operation: "generate", model: "test/text", detail: "failed" })),
          },
        }),
      );
      const ids = yield* store([38]);
      const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
        enricher.enrichRepos(ids, "batch"),
      ).pipe(using(failingBatch));
      expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Summarized"]);
      expect(direct).toBe(1);
    }),
  );

  it.effect("retries an item that is briefly unavailable when the model has no batch API", () =>
    Effect.gen(function* () {
      remotes.set(36, { description: "Photo app", readme: { oid: oid("6"), text: "# Photos" } });
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const flaky = textGeneration((request) =>
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? Deferred.succeed(attempted, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new AiUnavailable({ operation: "generate", model: "test/text", detail: "503" })),
                ),
              )
            : Effect.succeed({ output: SummarizeFake.respond(request.prompt), usage });
        }),
      );
      const ids = yield* store([36]);
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) => enricher.enrichRepos(ids, "batch")).pipe(using(flaky)),
      );
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(fiber)).map((outcome) => outcome._tag)).toEqual(["Summarized"]);
      expect(attempts).toBe(2);
    }),
  );
  it.effect("summarizes each repo with its own call in direct mode and starts no batch job", () =>
    Effect.gen(function* () {
      for (const n of [50, 51, 52]) {
        remotes.set(n, {
          description: `Direct ${n}`,
          readme: { oid: wideOid(n), text: `# Direct ${n}` },
        });
      }
      const calls = { direct: 0, batch: 0 };
      const batchCapable = Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.make({
          provider: "test",
          model: "test/text",
          timeout: Duration.seconds(5),
          run: (request) =>
            Effect.sync(() => {
              calls.direct++;
              return { output: SummarizeFake.respond(request.prompt), usage };
            }),
          batch: {
            timeout: Duration.hours(1),
            run: () =>
              Effect.suspend(() => {
                calls.batch++;
                return Effect.fail(new AiRequestFailed({ operation: "generate", model: "test/text", detail: "batch" }));
              }),
          },
        }),
      );
      const ids = yield* store([50, 51, 52]);
      const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
        enricher.enrichRepos(ids, "direct"),
      ).pipe(using(batchCapable));
      expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Summarized", "Summarized", "Summarized"]);
      expect(calls).toEqual({ direct: 3, batch: 0 });
    }),
  );

  it.effect("reads up to four READMEs from the blob store at once while it plans", () =>
    Effect.gen(function* () {
      const numbers = [60, 61, 62, 63, 64, 65, 66, 67];
      for (const n of numbers) {
        remotes.set(n, {
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
      const ids = yield* store(numbers);
      const outcomes = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
        enricher.enrichRepos(ids, "direct"),
      ).pipe(Effect.provide(Layer.fresh(EnrichRepo.layer).pipe(Layer.provide(slowBlobs))));
      expect(outcomes.map((outcome) => outcome._tag)).toEqual(numbers.map(() => "Summarized"));
      expect(reads.peak).toBe(4);
    }),
  );
});

describe("readmeKey", () => {
  it.effect("names a README blob by its object id", () =>
    Effect.sync(() => expect(EnrichRepo.readmeKey(oid("f"))).toBe(`readmes/${"f".repeat(40)}`)),
  );
});
