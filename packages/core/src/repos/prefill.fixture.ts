import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import type * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { Login, ObjectId, RepoId, RepoName } from "@stargrep/github/schemas";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as IconQueue from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichQueue from "./enrich-queue.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";
import * as Prefill from "./prefill.ts";

export const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const oid = (n: number) => Schema.decodeSync(ObjectId)(String(n).padStart(40, "c"));
export const ref = (n: number): GitHub.ArchiveRef => ({
  id: RepoId.make(n),
  owner: Login.make("owner"),
  name: RepoName.make(`repo-${n}`),
});
export const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

interface Remote {
  readonly description: string;
  // The ID GitHub now gives the name, when another repo took it.
  readonly databaseId?: number;
  readonly readme?: string;
  readonly isPrivate?: boolean;
}

export const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

export const invalid = { summary: "", keywords: [] };

export const fixture = () => {
  const remotes = new Map<number, Remote>();
  const node = (n: number, remote: Remote) => ({
    databaseId: remote.databaseId ?? n,
    id: `R_${remote.databaseId ?? n}`,
    name: `repo-${n}`,
    owner: { __typename: "User", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
    description: remote.description,
    homepageUrl: null,
    primaryLanguage: { name: "Go" },
    licenseInfo: { spdxId: "MIT" },
    repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
    createdAt: "2020-01-01T00:00:00Z",
    pushedAt: "2026-10-01T00:00:00Z",
    isArchived: false,
    isFork: false,
    isPrivate: remote.isPrivate ?? false,
    stargazerCount: 100,
    forkCount: 5,
    root: { entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: oid(n) }] },
  });
  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const { variables } = JSON.parse(sent.body ?? "{}") as { variables: Record<string, unknown> };
      if (Array.isArray(variables.ids)) {
        const nodes = variables.ids.map((nodeId: string) => {
          const n = Number(nodeId.slice(2));
          const remote = remotes.get(n);
          return remote === undefined ? null : node(n, remote);
        });
        return { body: { data: { nodes } } };
      }
      const data: Record<string, unknown> = {};
      const errors: Array<unknown> = [];
      for (let index = 0; `n${index}` in variables; index++) {
        const n = Number(String(variables[`n${index}`]).slice("repo-".length));
        const remote = remotes.get(n);
        data[`r${index}`] = remote === undefined ? null : node(n, remote);
        if (remote === undefined) errors.push({ type: "NOT_FOUND", path: [`r${index}`], message: "Not found" });
      }
      return { body: { data, errors } };
    }
    const blob = sent.url.pathname.split("/").at(-1);
    const found = [...remotes].find(([n]) => oid(n) === blob);
    return found?.[1].readme === undefined ? { status: 404 } : { body: found[1].readme };
  });

  // Every summary call the CLI path or a consumer makes, by prompt.
  const asked: Array<string> = [];
  const respond = (prompt: string) => {
    asked.push(prompt);
    return SummarizeFake.respond(prompt);
  };
  // The batch answers, by prompt: the stand-in's, unless a test names repos whose answers do not decode, the first
  // time each is asked or every time.
  const broken = { once: new Set<number>(), always: new Set<number>() };
  const repoOf = (prompt: string) => Number(prompt.slice("Repository: owner/repo-".length, prompt.indexOf("\n")));
  const batches = Fake.batches((prompt) => {
    const n = repoOf(prompt);
    if (broken.always.has(n)) return invalid;
    if (broken.once.delete(n)) return invalid;
    return SummarizeFake.respond(prompt);
  }, "fake/summary");

  const layer = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
    Layer.provideMerge(
      Layer.merge(Prefill.layer, EnrichRepo.layer),
      Layer.mergeAll(
        database,
        github.layer,
        BlobStore.layerMemory,
        batches.layer,
        IconQueue.layerMemory().layer,
        Fake.layerTextGeneration(respond, "fake/summary"),
        Fake.layerEmbeddings(),
      ),
    );

  const seed = (numbers: ReadonlyArray<number>) => {
    for (const n of numbers) remotes.set(n, { description: `A CLI for task ${n}`, readme: `# repo-${n}\n\nA CLI.` });
  };

  return { remotes, github, asked, batches, broken, layer, seed };
};

export const run = (refs: ReadonlyArray<GitHub.ArchiveRef>) =>
  Effect.flatMap(Prefill.Prefill, (prefill) =>
    prefill.run({ refs, adapter: "gateway-batch", chunk: 250, concurrency: 4 }),
  );

export const tally = (report: Prefill.PrefillReport) => {
  const counts: Partial<Record<Prefill.Outcome, number>> = {};
  for (const outcome of report.outcomes.values()) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

export const query = (text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(TestDatabase.TestDatabase, (test) => test.query(text, values));

// The regular sweep, and the queue consumer's service on every repo it sends, as the deployed cron and queue run them.
// Returns the repos the sweep sent.
export const sweepAndConsume = Effect.gen(function* () {
  const queue = EnrichQueue.layerMemory();
  yield* EnrichRetry.sweep().pipe(Effect.provide(queue.layer));
  const enricher = yield* EnrichRepo.EnrichRepo;
  if (queue.sent.length > 0) yield* enricher.enrichRepos(queue.sent.map((message) => message.repoId));
  return queue.sent.map((message) => Number(message.repoId));
});

// The prompts among asked that name one of these repos.
export const askedFor = (asked: ReadonlyArray<string>, ids: ReadonlyArray<number>) =>
  asked.filter((prompt) => ids.some((n) => prompt.startsWith(`Repository: owner/repo-${n}\n`)));

// Runs a prefill and kills it when it reaches its nth capture, before that capture writes anything, as a crash would.
export const killedAtCapture = Effect.fn("test.killedAtCapture")(function* (
  refs: ReadonlyArray<GitHub.ArchiveRef>,
  nth: number,
) {
  const db = yield* Db.Db;
  const reached = yield* Deferred.make<void>();
  let captures = 0;
  const killing = Layer.succeed(
    Db.Db,
    Db.Db.of({
      ...db,
      knowledge: {
        ...db.knowledge,
        capture: (answers) =>
          ++captures === nth
            ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
            : db.knowledge.capture(answers),
      },
    }),
  );
  const running = yield* run(refs).pipe(
    Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(killing))),
    Effect.forkChild,
  );
  yield* Deferred.await(reached);
  yield* Fiber.interrupt(running);
});
