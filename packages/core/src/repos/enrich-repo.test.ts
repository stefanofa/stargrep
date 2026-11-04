import { expect } from "bun:test";
import { AiUnavailable } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as Memory from "@stargrep/db/memory";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId, Repo } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRepo from "./enrich-repo.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const oid = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
const repo = (n: number) => Schema.decodeSync(Repo)({ id: n, nodeId: `R_${n}`, owner: "owner", name: `repo-${n}` });
const id = (n: number) => repo(n).id;

const store = Effect.fn("test.store")(function* (numbers: ReadonlyArray<number>) {
  const db = yield* Db.Db;
  const refs = numbers.map(repo);
  yield* db.repos.upsertRefs(refs);
  return refs.map((ref) => ref.id);
});

const enrich = (n: number) => Effect.flatMap(store([n]), () => EnrichRepo.enrichRepo(id(n)));

interface Remote {
  readonly description: string | null;
  readonly archived?: boolean;
  readonly readme?: { readonly oid: ObjectId; readonly text: string };
}

const remotes = new Map<number, Remote>();

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
    const nodes = ids.map((id) => {
      const n = Number(id.slice(2));
      const remote = remotes.get(n);
      return remote === undefined ? null : node(n, remote);
    });
    return { body: { data: { nodes } } };
  }
  const blob = sent.url.pathname.split("/").at(-1);
  const remote = [...remotes.values()].find((entry) => entry.readme?.oid === blob);
  return remote?.readme === undefined ? { status: 404 } : { body: remote.readme.text, headers: { etag: `"${blob}"` } };
});

const readmeRequests = () => github.sent.filter((sent) => sent.url.pathname.includes("/git/blobs/")).length;

const prompts: Array<string> = [];
const textLayer = Fake.layerTextGeneration((prompt) => {
  prompts.push(prompt);
  return prompt.includes("Repository: owner/repo-14\n")
    ? { summary: "", keywords: [], kind: "app" }
    : SummarizeFake.respond(prompt);
});

const testLayer = Layer.mergeAll(
  Memory.layerMemory({ embeddingModel }),
  github.layer,
  BlobStore.layerMemory,
  textLayer,
  Fake.layerEmbeddings(),
);

const usage = { inputTokens: 1, outputTokens: 1 };

const textGeneration = (
  run: (request: TextGeneration.RunRequest) => Effect.Effect<TextGeneration.RunResult, AiUnavailable>,
) =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({ provider: "test", model: "test/text", timeout: Duration.seconds(5), run }),
  );

it.layer(testLayer, { timeout: 30_000 })("enrichRepo", (it) => {
  it.effect("stores facts, the README blob, the summary, and its embedding for a new repo", () =>
    Effect.gen(function* () {
      remotes.set(1, {
        description: "Fast log parser",
        archived: true,
        readme: { oid: oid("a"), text: "# Parser\n\n![logo](logo.png)\n\nParses web server logs." },
      });
      const outcome = yield* enrich(1);
      expect(outcome).toMatchObject({ _tag: "Enriched", summarized: true, dimensions: 1024 });

      const db = yield* Db.Db;
      const stored = Option.getOrThrow(yield* db.repos.get(id(1)));
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
      expect(Option.getOrThrow(yield* blobs.get(`readmes/${oid("a")}`))).toContain("Parses web server logs.");
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
      const before = Option.getOrThrow(yield* db.repos.get(id(3)));
      yield* db.repos.saveFacts({ ...before, readmeOid: oid("d") });

      const outcome = yield* enrich(3);
      expect(outcome).toMatchObject({ _tag: "Enriched", summarized: true });
      const after = Option.getOrThrow(yield* db.repos.get(id(3)));
      expect(after.summaryReadmeOid).toBe(oid("d"));
      expect(after.summary).toContain("Syncs phones.");
      expect(after.embeddingModel).toBe(embeddingModel);
    }),
  );

  it.effect("summarizes a repo with no README from its description", () =>
    Effect.gen(function* () {
      remotes.set(4, { description: "Dotfiles for macOS" });
      const readmes = readmeRequests();
      const outcome = yield* enrich(4);
      expect(outcome._tag === "Enriched" && outcome.summary.summary).toStartWith("Dotfiles for macOS");
      expect(prompts.at(-1)).toContain("README:\nnone");
      expect(readmeRequests()).toBe(readmes);
    }),
  );

  it.effect("keeps facts and leaves the repo pending when the model output is invalid", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(5, { description: "Image viewer", readme: { oid: oid("e"), text: "# Viewer" } });
      const error = yield* Effect.flip(
        enrich(5).pipe(Effect.provide(textGeneration(() => Effect.succeed({ output: { summary: "" }, usage })))),
      );
      expect(error._tag).toBe("AiOutputInvalid");
      const stored = Option.getOrThrow(yield* db.repos.get(id(5)));
      expect(stored).toMatchObject({ license: "MIT", readmeOid: oid("e"), summary: null, embeddingModel: null });
      expect(yield* db.repos.pendingEnrichment([id(5)])).toEqual([id(5)]);

      const readmes = readmeRequests();
      expect(yield* enrich(5)).toMatchObject({ _tag: "Enriched" });
      expect(readmeRequests()).toBe(readmes);
    }),
  );

  it.effect("retries a model that is briefly unavailable", () =>
    Effect.gen(function* () {
      remotes.set(6, { description: "Markdown editor", readme: { oid: oid("f"), text: "# Editor" } });
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const flaky = textGeneration((request) => {
        attempts++;
        return attempts === 1
          ? Deferred.succeed(attempted, undefined).pipe(
              Effect.andThen(
                Effect.fail(new AiUnavailable({ operation: "generate", model: "test/text", detail: "503" })),
              ),
            )
          : Effect.succeed({ output: SummarizeFake.respond(request.prompt), usage });
      });
      const fiber = yield* Effect.forkChild(enrich(6).pipe(Effect.provide(flaky)));
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Enriched" });
      expect(attempts).toBe(2);
    }),
  );

  it.effect("embeds a stored summary again without a model call when its embedding is missing", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(7, { description: "HTTP client", readme: { oid: oid("1"), text: "# Client" } });
      yield* enrich(7);
      const stored = Option.getOrThrow(yield* db.repos.get(id(7)));
      yield* db.repos.saveSummary({
        id: stored.id,
        readmeOid: stored.readmeOid,
        summary: stored.summary ?? "",
        keywords: stored.keywords,
        kind: stored.kind ?? "",
      });
      const calls = prompts.length;
      expect(yield* enrich(7)).toMatchObject({ _tag: "Enriched", summarized: false });
      expect(prompts.length).toBe(calls);
      expect(Option.getOrThrow(yield* db.repos.get(id(7))).embeddingModel).toBe(embeddingModel);
    }),
  );

  it.effect("drops a summary whose README changed while the model ran", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      remotes.set(8, { description: "Chat app", readme: { oid: oid("2"), text: "# Chat" } });
      const racing = textGeneration((request) =>
        db.repos.get(id(8)).pipe(
          Effect.map(Option.getOrThrow),
          Effect.flatMap((row) => db.repos.saveFacts({ ...row, readmeOid: oid("3") })),
          Effect.orDie,
          Effect.as({ output: SummarizeFake.respond(request.prompt), usage }),
        ),
      );
      expect(yield* enrich(8).pipe(Effect.provide(racing))).toEqual({
        _tag: "Stale",
        id: id(8),
      });
      const stored = Option.getOrThrow(yield* db.repos.get(id(8)));
      expect(stored).toMatchObject({ summary: null, embeddingModel: null, readmeOid: oid("3") });
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
      expect(yield* EnrichRepo.enrichRepo(repoId)).toEqual({ _tag: "NoNodeId", id: repoId });
      expect(github.sent.length).toBe(sent);
    }),
  );
});

it.layer(testLayer, { timeout: 30_000 })("enrichRepos", (it) => {
  it.effect("enriches a batch, reports gone and failed repos, and summarizes nothing twice on a rerun", () =>
    Effect.gen(function* () {
      for (const n of [10, 11, 12, 14]) {
        remotes.set(n, { description: `Tool ${n}`, readme: { oid: oid(String(n % 10)), text: `# Tool ${n}` } });
      }
      const batch = yield* store([14, 13, 12, 11, 10]);
      const first = yield* EnrichRepo.enrichRepos(batch);
      expect(first.map((outcome): [number, string] => [outcome.id, outcome._tag])).toEqual([
        [10, "Enriched"],
        [11, "Enriched"],
        [12, "Enriched"],
        [13, "Gone"],
        [14, "Failed"],
      ]);

      const calls = prompts.length;
      const second = yield* EnrichRepo.enrichRepos(batch);
      expect(second.map((outcome) => outcome._tag)).toEqual(["Unchanged", "Unchanged", "Unchanged", "Gone", "Failed"]);
      expect(prompts.slice(calls).map((prompt) => prompt.split("\n")[0])).toEqual(["Repository: owner/repo-14"]);
    }),
  );
});
