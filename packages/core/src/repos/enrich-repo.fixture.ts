import * as Embeddings from "@stargrep/ai/embeddings";
import { AiRequestFailed, type AiUnavailable } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId, Repo, type RepoId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IconQueue from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRepo from "./enrich-repo.ts";

export const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
export const oid = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
export const wideOid = (n: number) => Schema.decodeSync(ObjectId)(String(n).padStart(40, "b"));
export const repo = (n: number) =>
  Schema.decodeSync(Repo)({ id: n, nodeId: `R_${n}`, owner: "owner", name: `repo-${n}` });
export const id = (n: number) => repo(n).id;

interface Remote {
  readonly description: string | null;
  readonly archived?: boolean;
  readonly readme?: { readonly oid: ObjectId; readonly text: string };
  readonly stars?: number;
  readonly forks?: number;
  readonly forbidden?: boolean;
}

export const fixture = () => {
  const remotes = new Map<number, Remote>();
  const missingBlob = "\u0000missing";

  const node = (n: number, remote: Remote) => ({
    databaseId: n,
    id: `R_${n}`,
    name: `repo-${n}`,
    owner: { __typename: "Organization", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
    description: remote.description,
    homepageUrl: `https://repo-${n}.dev`,
    primaryLanguage: { name: "Rust" },
    licenseInfo: { spdxId: "MIT" },
    repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
    createdAt: "2020-01-01T00:00:00Z",
    pushedAt: "2026-10-01T00:00:00Z",
    isArchived: remote.archived ?? false,
    isFork: false,
    stargazerCount: remote.stars ?? 10,
    forkCount: remote.forks ?? 1,
    root: { entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: remote.readme.oid }] },
  });

  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const ids: ReadonlyArray<string> = JSON.parse(sent.body ?? "{}").variables.ids;
      const asked = ids.map((nodeId) => Number(nodeId.slice(2)));
      const nodes = asked.map((n) => {
        const remote = remotes.get(n);
        return remote === undefined || remote.forbidden ? null : node(n, remote);
      });
      const errors = asked.flatMap((n, index) =>
        remotes.get(n)?.forbidden
          ? [{ type: "FORBIDDEN", path: ["nodes", index], message: "Resource not accessible" }]
          : [],
      );
      return { body: { data: { nodes }, errors } };
    }
    const blob = sent.url.pathname.split("/").at(-1);
    const remote = [...remotes.values()].find((entry) => entry.readme?.oid === blob);
    return remote?.readme === undefined || remote.readme.text === missingBlob
      ? { status: 404 }
      : { body: remote.readme.text };
  });

  const readmeRequests = () => github.sent.filter((sent) => sent.url.pathname.includes("/git/blobs/")).length;

  const iconQueue = IconQueue.layerMemory();

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
        model: { ...Fake.hashEmbeddingModel, id: embeddingModel },
        timeout: Duration.seconds(5),
        run,
      }),
    );

  const failingEmbeddings = embeddingsWith(() =>
    Effect.fail(new AiRequestFailed({ operation: "embed", model: embeddingModel, detail: "bad request" })),
  );

  const wrongSizeEmbeddings = embeddingsWith((values) =>
    Effect.succeed({ vectors: values.map(() => Array.from({ length: 512 }, () => 0.1)), tokens: values.length }),
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
        iconQueue.layer,
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

  const enrichOne = (repoId: RepoId) =>
    Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
      Effect.map(enricher.enrichRepos([repoId]), (outcomes) => Option.getOrThrow(Arr.head(outcomes))),
    );

  const enrich = (n: number) => Effect.andThen(store([n]), enrichOne(id(n)));

  const get = (n: number) => Effect.flatMap(Db.Db, (db) => Effect.map(db.repos.get(id(n)), Option.getOrThrow));

  const failuresOf = (n: number) =>
    Effect.flatMap(TestDatabase.TestDatabase, (database) =>
      database.query("select enrich_failures from repos where id = $1", [n]),
    );

  const countsOf = (n: number) =>
    Effect.flatMap(TestDatabase.TestDatabase, (database) =>
      database.query("select stars, forks from repo_metrics where repo_id = $1", [n]),
    );

  const resummarize = Effect.fn("test.resummarize")(function* (n: number) {
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

  return {
    remotes,
    missingBlob,
    github,
    readmeRequests,
    iconQueue,
    prompts,
    usage,
    textGeneration,
    embeddingsWith,
    failingEmbeddings,
    wrongSizeEmbeddings,
    vectors,
    enrichment,
    using,
    store,
    enrichOne,
    enrich,
    get,
    failuresOf,
    countsOf,
    resummarize,
  };
};
