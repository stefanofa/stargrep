import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
import * as Summarize from "@stargrep/ai/summarize";
import type * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { Embedding } from "@stargrep/db/embedding";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { ObjectId, RepoFacts, RepoId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as BlobStore from "./blob-store.ts";
import { readmeText } from "./readme-text.ts";

export interface Summary {
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind: string | null;
}

export type RepoError = AiError | GitHubError | BlobStore.BlobStoreFailed;

export type Enrichment =
  | { readonly _tag: "Unchanged"; readonly id: RepoId }
  | { readonly _tag: "Gone"; readonly id: RepoId }
  | { readonly _tag: "NoNodeId"; readonly id: RepoId }
  | { readonly _tag: "Stale"; readonly id: RepoId }
  | { readonly _tag: "Failed"; readonly id: RepoId; readonly error: RepoError }
  | {
      readonly _tag: "Enriched";
      readonly id: RepoId;
      readonly summary: Summary;
      readonly summarized: boolean;
      readonly dimensions: number;
    };

type Work =
  | { readonly _tag: "Current" }
  | { readonly _tag: "Embed"; readonly summary: Summary }
  | { readonly _tag: "Summarize" };

interface Planned {
  readonly id: RepoId;
  readonly facts: RepoFacts;
  readonly work: Work;
}

interface Summarized {
  readonly entry: Planned;
  readonly summary: Summary;
  readonly fresh: Option.Option<Db.RepoSummary>;
}

interface Ready {
  readonly id: RepoId;
  readonly readmeOid: ObjectId | null;
  readonly summary: Summary;
  readonly fresh: Option.Option<Db.RepoSummary>;
  readonly embedding: Embedding;
}

type Summarizer = (
  repos: ReadonlyArray<Summarize.RepoFacts>,
) => Effect.Effect<TextGeneration.BatchResults<Summarize.RepoSummary>, AiError, TextGeneration.TextGeneration>;

export const batchSize = 250;
const batchConcurrency = 4;
const embedBatchSize = 128;

const transient = {
  times: 3,
  schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
  while: (error: AiError) => error._tag === "AiUnavailable",
};

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const readmeOidOf = (facts: RepoFacts) => facts.readme?.oid ?? null;

const classify = (facts: RepoFacts, row: Db.Repo): Work => {
  if (row.summary === null || row.summaryReadmeOid !== readmeOidOf(facts)) return { _tag: "Summarize" };
  if (row.embeddingModel === null) {
    return { _tag: "Embed", summary: { summary: row.summary, keywords: row.keywords, kind: row.kind } };
  }
  return { _tag: "Current" };
};

const storedFacts = (facts: RepoFacts): Db.RepoFacts => ({
  id: facts.id,
  owner: facts.owner,
  name: facts.name,
  description: facts.description,
  topics: facts.topics,
  language: facts.language,
  license: facts.license,
  homepage: facts.homepage,
  createdAt: facts.createdAt,
  pushedAt: facts.pushedAt,
  archived: facts.archived,
  readmeOid: readmeOidOf(facts),
});

const fullName = (facts: RepoFacts) => `${facts.owner}/${facts.name}`;

const readme = Effect.fn("EnrichRepo.readme")(function* (facts: RepoFacts) {
  if (facts.readme === null) return null;
  const blobs = yield* BlobStore.BlobStore;
  const key = BlobStore.readmeKey(facts.readme.oid);
  const stored = yield* blobs.get(key);
  if (Option.isSome(stored)) return stored.value;
  const github = yield* GitHub.GitHub;
  const text = yield* github.readme({ owner: facts.owner, name: facts.name, oid: facts.readme.oid });
  yield* blobs.put(key, text);
  return text;
});

const promptFacts = (facts: RepoFacts) =>
  readme(facts).pipe(
    Effect.map(
      (text): Summarize.RepoFacts => ({
        fullName: fullName(facts),
        description: facts.description,
        topics: facts.topics,
        language: facts.language,
        readme: text === null ? null : readmeText(text),
      }),
    ),
  );

const summarizeEach: Summarizer = (repos) =>
  Effect.forEach(repos, (facts) => Effect.result(Summarize.summarize(facts).pipe(Effect.retry(transient))));

const summarizeInBatch: Summarizer = (repos) => Summarize.summarizeBatch(repos).pipe(Effect.retry(transient));

const failed = (id: RepoId, error: RepoError): Enrichment => ({ _tag: "Failed", id, error });

const summarizeAll = Effect.fnUntraced(function* (entries: ReadonlyArray<Planned>, summarizer: Summarizer) {
  const prompts = yield* Effect.forEach(entries, (entry) => Effect.result(promptFacts(entry.facts)));
  const [ready, unreadable] = Arr.partition(Arr.zip(entries, prompts), ([entry, prompt]) =>
    Result.isSuccess(prompt)
      ? Result.succeed([entry, prompt.success] as const)
      : Result.fail(failed(entry.id, prompt.failure)),
  );
  const summaries =
    ready.length === 0
      ? []
      : yield* summarizer(ready.map(([, facts]) => facts)).pipe(
          Effect.catch((error) => Effect.succeed(ready.map(() => Result.fail(error)))),
        );
  const [summarized, unsummarized] = Arr.partition(Arr.zip(ready, summaries), ([[entry], summary]) =>
    Result.isSuccess(summary)
      ? Result.succeed<Summarized>({
          entry,
          summary: summary.success,
          fresh: Option.some({ id: entry.id, readmeOid: readmeOidOf(entry.facts), ...summary.success }),
        })
      : Result.fail(failed(entry.id, summary.failure)),
  );
  return { summarized, failures: [...unreadable, ...unsummarized] };
});

const embedAll = Effect.fn("EnrichRepo.embedAll")(function* (items: ReadonlyArray<Summarized>) {
  const embeddings = yield* Embeddings.Embeddings;
  const chunks = yield* Effect.forEach(Arr.chunksOf(items, embedBatchSize), (chunk) =>
    embeddings
      .embed(
        chunk.map(({ entry, summary }) =>
          Summarize.embeddingText({ fullName: fullName(entry.facts), description: entry.facts.description }, summary),
        ),
      )
      .pipe(
        Effect.retry(transient),
        Effect.flatMap((vectors) => Effect.forEach(vectors, (vector) => Effect.orDie(decodeEmbedding(vector)))),
        Effect.map((vectors) => vectors.map((vector) => Result.succeed(vector))),
        Effect.catch((error) => Effect.succeed(chunk.map(() => Result.fail(error)))),
      ),
  );
  return Arr.partition(Arr.zip(items, chunks.flat()), ([item, vector]) =>
    Result.isSuccess(vector)
      ? Result.succeed<Ready>({
          id: item.entry.id,
          readmeOid: readmeOidOf(item.entry.facts),
          summary: item.summary,
          fresh: item.fresh,
          embedding: vector.success,
        })
      : Result.fail(failed(item.entry.id, vector.failure)),
  );
});

const save = Effect.fn("EnrichRepo.save")(function* (ready: Ready) {
  const db = yield* Db.Db;
  const { id } = ready;
  if (Option.isSome(ready.fresh)) yield* db.repos.saveSummary(ready.fresh.value);
  const stored = yield* db.repos.get(id);
  const current = Option.exists(
    stored,
    (row) => row.summary === ready.summary.summary && row.summaryReadmeOid === ready.readmeOid,
  );
  if (!current) return { _tag: "Stale", id } satisfies Enrichment;
  yield* db.repos.saveEmbedding({ id, embedding: ready.embedding });
  return {
    _tag: "Enriched",
    id,
    summary: ready.summary,
    summarized: Option.isSome(ready.fresh),
    dimensions: ready.embedding.vector.length,
  } satisfies Enrichment;
});

const plan = Effect.fn("EnrichRepo.plan")(function* (ids: ReadonlyArray<RepoId>) {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const pendingIds = new Set<number>(yield* db.repos.pendingEnrichment(ids));
  const unchanged = ids.filter((id) => !pendingIds.has(id)).map((id): Enrichment => ({ _tag: "Unchanged", id }));
  const rows = yield* Effect.forEach(
    ids.filter((id) => pendingIds.has(id)),
    (id) => db.repos.get(id),
  ).pipe(Effect.map(Arr.getSomes));
  const [pending, unlocated] = Arr.partition(rows, (row) =>
    row.nodeId === null
      ? Result.fail<Enrichment>({ _tag: "NoNodeId", id: row.id })
      : Result.succeed({ id: row.id, row, nodeId: row.nodeId }),
  );
  const facts = pending.length === 0 ? [] : yield* github.repoFacts(pending.map((entry) => entry.nodeId));
  const factsById = new Map<number, RepoFacts>(facts.map((entry) => [entry.id, entry]));
  const planned: ReadonlyArray<Result.Result<Planned, Enrichment>> = yield* Effect.forEach(pending, ({ id, row }) =>
    Effect.gen(function* () {
      const entry = factsById.get(id);
      if (entry === undefined) return Result.fail({ _tag: "Gone", id } satisfies Enrichment);
      yield* db.repos.saveFacts(storedFacts(entry));
      return Result.succeed({ id, facts: entry, work: classify(entry, row) } satisfies Planned);
    }),
  );
  return { skipped: [...unchanged, ...unlocated], planned };
});

const enrichChunk = Effect.fnUntraced(function* (ids: ReadonlyArray<RepoId>, summarizer: Summarizer) {
  const { withTransaction } = yield* Db.Transactions;
  const { skipped, planned } = yield* plan(ids);
  const [work, settled] = Arr.separate(planned);
  const current = work
    .filter((entry) => entry.work._tag === "Current")
    .map((entry): Enrichment => ({ _tag: "Unchanged", id: entry.id }));
  const stored = work.flatMap(
    (entry): ReadonlyArray<Summarized> =>
      entry.work._tag === "Embed" ? [{ entry, summary: entry.work.summary, fresh: Option.none() }] : [],
  );
  const { summarized, failures } = yield* summarizeAll(
    work.filter((entry) => entry.work._tag === "Summarize"),
    summarizer,
  );
  const [ready, unembedded] = yield* embedAll([...summarized, ...stored]);
  const saved = yield* withTransaction(Effect.forEach(ready, save));
  const outcomes = new Map<number, Enrichment>(
    [...skipped, ...settled, ...current, ...failures, ...unembedded, ...saved].map((outcome) => [outcome.id, outcome]),
  );
  return ids.flatMap((id) => Option.toArray(Option.fromUndefinedOr(outcomes.get(id))));
});

export const enrichRepo = Effect.fn("EnrichRepo.enrichRepo")(function* (id: RepoId) {
  const [outcome = { _tag: "Unchanged", id }] = yield* enrichChunk([id], summarizeEach);
  if (outcome._tag === "Failed") return yield* outcome.error;
  return outcome;
});

export const enrichRepos = Effect.fn("EnrichRepo.enrichRepos")(function* (ids: ReadonlyArray<RepoId>) {
  const chunks = Arr.chunksOf(Arr.sort(Arr.dedupe(ids), Order.Number), batchSize);
  const outcomes = yield* Effect.forEach(chunks, (chunk) => enrichChunk(chunk, summarizeInBatch), {
    concurrency: batchConcurrency,
  });
  return outcomes.flat();
});
