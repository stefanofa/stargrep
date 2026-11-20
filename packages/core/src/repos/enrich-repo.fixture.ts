import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiRequestFailed } from "@stargrep/ai/errors";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { summarize } from "@stargrep/db/testing";
import { blobOid } from "@stargrep/github/blob-oid";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId, Repo, type RepoId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IconQueue from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as SummaryAllowance from "./summary-allowance.ts";

export const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
export const oid = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
export const wideOid = (n: number) => Schema.decodeSync(ObjectId)(String(n).padStart(40, "b"));
// The real object ID git gives a README, which a GraphQL README batch can return.
export const blobOidOf = (text: string) =>
  Effect.map(blobOid(new TextEncoder().encode(text)), Schema.decodeSync(ObjectId)).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );
export const repo = (n: number) =>
  Schema.decodeSync(Repo)({ id: n, nodeId: `R_${n}`, owner: "owner", name: `repo-${n}` });
export const id = (n: number) => repo(n).id;

interface Remote {
  readonly description: string | null;
  readonly topics?: ReadonlyArray<string>;
  readonly archived?: boolean;
  readonly readme?: { readonly oid: ObjectId; readonly text: string };
  readonly stars?: number;
  readonly forks?: number;
  readonly forbidden?: boolean;
  // GitHub sends its facts with a null databaseId, which its schema allows and no repo row can be keyed by.
  readonly unkeyed?: boolean;
}

export const fixture = () => {
  const remotes = new Map<number, Remote>();
  const missingBlob = "\u0000missing";

  const node = (n: number, remote: Remote) => ({
    databaseId: remote.unkeyed === true ? null : n,
    id: `R_${n}`,
    name: `repo-${n}`,
    owner: { __typename: "Organization", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
    description: remote.description,
    homepageUrl: `https://repo-${n}.dev`,
    primaryLanguage: { name: "Rust" },
    licenseInfo: { spdxId: "MIT" },
    repositoryTopics: { nodes: (remote.topics ?? ["cli"]).map((name) => ({ topic: { name } })) },
    createdAt: "2020-01-01T00:00:00Z",
    pushedAt: "2026-10-01T00:00:00Z",
    isArchived: remote.archived ?? false,
    isFork: false,
    isPrivate: false,
    // Enough stars for the summary policy to want a summary, unless a test sets fewer.
    stargazerCount: remote.stars ?? 500,
    forkCount: remote.forks ?? 1,
    root: { entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: remote.readme.oid }] },
  });

  // A README batch answers each repo by node ID with the blob it asks for, when the repo still has that README.
  const readmeBatch = (variables: Record<string, string>): GitHubFake.Reply => {
    const data: Record<string, unknown> = {};
    const errors: Array<unknown> = [];
    for (let index = 0; `r${index}` in variables; index++) {
      const remote = remotes.get(Number(variables[`r${index}`]?.slice(2)));
      if (remote === undefined || remote.forbidden) {
        data[`b${index}`] = null;
        const type = remote === undefined ? "NOT_FOUND" : "FORBIDDEN";
        errors.push({ type, path: [`b${index}`], message: "Could not resolve to a node" });
        continue;
      }
      const readme = remote.readme;
      const served = readme !== undefined && readme.text !== missingBlob && readme.oid === variables[`o${index}`];
      data[`b${index}`] = { object: served ? { text: readme.text } : null };
    }
    return { body: { data, errors } };
  };

  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(sent.body ?? "{}");
      if (String(query).startsWith("query Readmes")) return readmeBatch(variables);
      const ids: ReadonlyArray<string> = variables.ids;
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
  const readmeBatches = () => github.sent.filter((sent) => (sent.body ?? "").includes("query Readmes")).length;

  const iconQueue = IconQueue.layerMemory();

  const prompts: Array<string> = [];
  const respond = (prompt: string) => {
    prompts.push(prompt);
    return prompt.includes("Repository: owner/repo-34\n")
      ? { summary: "", keywords: [], facets: [] }
      : SummarizeFake.respond(prompt);
  };

  const usage = { inputTokens: 1, outputTokens: 1 };

  const textGeneration = (
    run: (request: TextGeneration.RunRequest) => Effect.Effect<TextGeneration.RunResult, AiError>,
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
        SummaryAllowance.layerUnmetered,
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

  // The same summary saved again, which marks a read repo's embedding stale.
  const resummarize = Effect.fn("test.resummarize")(function* (n: number) {
    const row = yield* get(n);
    yield* summarize({ id: row.id, readmeOid: row.readmeOid, summary: row.summary ?? "", keywords: row.keywords });
    return row;
  });

  return {
    remotes,
    missingBlob,
    github,
    readmeRequests,
    readmeBatches,
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
