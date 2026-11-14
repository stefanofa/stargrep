import { AiRefused, AiRequestFailed } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import type * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { Login, ObjectId, RepoId, RepoName } from "@stargrep/github/schemas";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
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
  // The README's real git object ID, so a GraphQL batch can return it. Without one, the README gets an ID its text
  // does not hash to, and only REST reads it.
  readonly readmeOid?: ObjectId;
  // The README GitHub lists that no read can return any longer.
  readonly readmeGone?: boolean;
  readonly isPrivate?: boolean;
}

export const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

export const invalid = { summary: "", keywords: [] };

export const fixture = () => {
  const remotes = new Map<number, Remote>();
  const readmeOid = (n: number, remote: Remote) => remote.readmeOid ?? oid(n);
  // README batches answer while on is set. A queued reply answers the next batch in its place.
  const readmeBatches = { on: true, replies: [] as Array<GitHubFake.Reply> };
  const readmeBatch = (variables: Record<string, unknown>): GitHubFake.Reply => {
    const data: Record<string, unknown> = {};
    const errors: Array<unknown> = [];
    for (let index = 0; `r${index}` in variables; index++) {
      const found = [...remotes].find(([n, remote]) => `R_${remote.databaseId ?? n}` === variables[`r${index}`]);
      if (found === undefined) {
        data[`b${index}`] = null;
        errors.push({ type: "NOT_FOUND", path: [`b${index}`], message: "Could not resolve to a node" });
        continue;
      }
      const [n, remote] = found;
      const served =
        remote.readme !== undefined && !remote.readmeGone && readmeOid(n, remote) === variables[`o${index}`];
      data[`b${index}`] = { object: served ? { text: remote.readme } : null };
    }
    return { body: { data, errors } };
  };
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
    root: {
      entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: readmeOid(n, remote) }],
    },
  });
  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(sent.body ?? "{}") as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (query.startsWith("query Readmes")) {
        return readmeBatches.replies.shift() ?? (readmeBatches.on ? readmeBatch(variables) : { body: { data: {} } });
      }
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
    const found = [...remotes].find(([n, remote]) => readmeOid(n, remote) === blob);
    return found?.[1].readme === undefined || found[1].readmeGone ? { status: 404 } : { body: found[1].readme };
  });

  // Every summary call the CLI path or a consumer makes, by prompt, failed calls included.
  const asked: Array<string> = [];
  // The batch answers, by prompt: the stand-in's, unless a test names repos whose answers do not decode, the first
  // time each is asked or every time.
  const broken = { once: new Set<number>(), always: new Set<number>() };
  const repoOf = (prompt: string) => Number(prompt.slice("Repository: owner/repo-".length, prompt.indexOf("\n")));
  // Repos whose direct calls fail the way a CLI that crashed or ran out of its subscription does, the first time each
  // is asked or every time.
  const failing = { once: new Set<number>(), always: new Set<number>() };
  // Repos the model refuses every time, as Haiku's safeguards refuse a remote access trojan, on either adapter.
  const refusing = new Set<number>();
  const refusal = new AiRefused({ operation: "generate", model: "fake/summary", detail: "claude reported a refusal" });
  const textGeneration = Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.make({
      provider: "fake",
      model: "fake/summary",
      timeout: Duration.seconds(5),
      run: (request) => {
        asked.push(request.prompt);
        const n = repoOf(request.prompt);
        if (refusing.has(n)) return Effect.fail(refusal);
        return failing.always.has(n) || failing.once.delete(n)
          ? Effect.fail(
              new AiRequestFailed({
                operation: "generate",
                model: "fake/summary",
                detail: "claude exited with code 1",
              }),
            )
          : Effect.sync(() => ({
              output: SummarizeFake.respond(request.prompt),
              usage: { inputTokens: 1, outputTokens: 1 },
            }));
      },
    }),
  );
  const batches = Fake.batches((prompt) => {
    const n = repoOf(prompt);
    if (refusing.has(n)) return Result.fail(refusal);
    if (broken.always.has(n)) return Result.succeed(invalid);
    if (broken.once.delete(n)) return Result.succeed(invalid);
    return Result.succeed(SummarizeFake.respond(prompt));
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
        textGeneration,
        Fake.layerEmbeddings(),
      ),
    );

  const seed = (numbers: ReadonlyArray<number>) => {
    for (const n of numbers) remotes.set(n, { description: `A CLI for task ${n}`, readme: `# repo-${n}\n\nA CLI.` });
  };

  // The README batches and the REST README reads sent to GitHub.
  const readmeReads = () => ({
    batches: github.sent.filter((sent) => (sent.body ?? "").includes("query Readmes")).length,
    rest: github.sent.filter((sent) => sent.url.pathname.includes("/git/blobs/")).length,
  });

  return { remotes, github, readmeBatches, readmeReads, asked, batches, broken, failing, refusing, layer, seed };
};

export const runWith = (refs: ReadonlyArray<GitHub.ArchiveRef>, options: Partial<Prefill.PrefillOptions>) =>
  Effect.flatMap(Prefill.Prefill, (prefill) =>
    prefill.run({ refs, adapter: "gateway-batch", chunk: 250, concurrency: 4, ...options }),
  );

export const run = (refs: ReadonlyArray<GitHub.ArchiveRef>) => runWith(refs, {});

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

// The driver's log. retrying waits for its next chunk retry, after which the driver sleeps with no query in flight, so a
// test can move the clock without timing out a query.
export const watchLogs = Effect.gen(function* () {
  const logs = yield* Queue.unbounded<unknown>();
  return {
    layer: Logger.layer([Logger.make(({ message }) => Queue.offerUnsafe(logs, message))]),
    retrying: Queue.take(logs).pipe(
      Effect.repeat({ until: (message) => JSON.stringify(message).includes("trying it again") }),
      Effect.asVoid,
    ),
  };
});

// Jitter pinned to a factor of 1, so a test moves the clock exactly onto each retry's wake. A jump past a wake would land
// on the queries the woken driver sends, and time them out.
export const unjittered = Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 });

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
