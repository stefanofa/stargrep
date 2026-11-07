import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
import * as Models from "@stargrep/ai/models";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { ObjectId, RepoFacts, RepoId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { IconQueue, iconRequest, needsIconCheck } from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRetry from "./enrich-retry.ts";

export interface Summary {
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind: string | null;
}

export type EnrichRepoError = AiError | GitHubError | BlobStore.BlobStoreFailed;

export type Enrichment = Data.TaggedEnum<{
  Unchanged: { readonly id: RepoId };
  NotFound: { readonly id: RepoId };
  NoNodeId: { readonly id: RepoId };
  Gone: { readonly id: RepoId };
  Backoff: { readonly id: RepoId };
  Stale: { readonly id: RepoId };
  Failed: { readonly id: RepoId; readonly error: EnrichRepoError };
  Summarized: { readonly id: RepoId; readonly summary: Summary };
  Embedded: { readonly id: RepoId; readonly summary: Summary };
}>;
export const Enrichment = Data.taggedEnum<Enrichment>();

// Whether an error is the repo's own, so it counts toward the cap. An error every repo would hit, such as a missing
// key, an outage, or a rate limit, never counts, and the sweep or the queue tries the repo again.
const ownError = (error: EnrichRepoError): boolean =>
  Match.valueTags(error, {
    NotFound: () => true,
    GitHubRequestFailed: (failure) =>
      failure.reason === "status" && failure.status !== null && failure.status < 500 && failure.status !== 403,
    GitHubResponseInvalid: (failure) => failure.reason !== "unreadable-body",
    // A summary answer is one paid call for one repo, so a repo whose answers never decode must reach the cap. An
    // embedding answer covers a whole batch, so its bad shape is the provider's fault, not any one repo's.
    AiOutputInvalid: (failure) => failure.operation === "generate",
    RateLimited: () => false,
    TokenBudgetExhausted: () => false,
    Unauthorized: () => false,
    GitHubTokenMissing: () => false,
    BlobStoreFailed: () => false,
    AiKeyMissing: () => false,
    AiModelNotFound: () => false,
    AiRequestFailed: () => false,
    AiTimeout: () => false,
    AiUnavailable: () => false,
  });

const repoFailed = (outcome: Enrichment): boolean =>
  Enrichment.$match(outcome, {
    Gone: () => true,
    NoNodeId: () => true,
    Failed: ({ error }) => ownError(error),
    Unchanged: () => false,
    NotFound: () => false,
    Backoff: () => false,
    Stale: () => false,
    Summarized: () => false,
    Embedded: () => false,
  });

export type EnrichRepoAbort = DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch | GitHubError;

export class EnrichRepo extends Context.Service<
  EnrichRepo,
  {
    readonly enrichRepos: (ids: ReadonlyArray<RepoId>) => Effect.Effect<ReadonlyArray<Enrichment>, EnrichRepoAbort>;
  }
>()("@stargrep/core/repos/enrich-repo/EnrichRepo") {}

type Work =
  | { readonly _tag: "Embed"; readonly summary: Summary }
  | { readonly _tag: "Summarize"; readonly prompt: Summarize.RepoFacts };

interface Job {
  readonly id: RepoId;
  readonly facts: RepoFacts;
  readonly work: Work;
}

interface Embeddable {
  readonly job: Job;
  readonly summary: Summary;
}

type Step<A> = Result.Result<A, Enrichment>;

const batchSize = 250;
const batchConcurrency = 4;
const planConcurrency = 4;
const saveConcurrency = 4;
const embedBatchSize = 128;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

const readmeOidOf = (facts: RepoFacts) => facts.readme?.oid ?? null;

const summaryOf = (row: Db.StoredRepo, readmeOid: ObjectId | null): Option.Option<Summary> =>
  row.summary !== null && row.summaryReadmeOid === readmeOid && row.summaryRecipe === Models.summaryRecipe
    ? Option.some({ summary: row.summary, keywords: row.keywords, kind: row.kind })
    : Option.none();

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
  ownerType: facts.ownerType,
  ownerAvatarUrl: facts.ownerAvatarUrl,
});

const fullName = (facts: RepoFacts) => `${facts.owner}/${facts.name}`;

const guarded = <A, E>(id: RepoId, save: Effect.Effect<boolean, E | RepoNotFound>, saved: A) =>
  save.pipe(
    Effect.map((applied): Step<A> => (applied ? Result.succeed(saved) : Result.fail(Enrichment.Stale({ id })))),
    Effect.catchTags({ RepoNotFound: () => Effect.succeed(Result.fail(Enrichment.NotFound({ id }))) }),
  );

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const blobs = yield* BlobStore.BlobStore;
  const embeddings = yield* Embeddings.Embeddings;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const icons = yield* IconQueue;

  const readme = Effect.fn("EnrichRepo.readme")(function* (facts: RepoFacts) {
    if (facts.readme === null) return null;
    const key = BlobStore.readmeKey(facts.readme.oid);
    const stored = yield* blobs.get(key);
    if (Option.isSome(stored)) return stored.value;
    const text = yield* github.readme({ owner: facts.owner, name: facts.name, oid: facts.readme.oid });
    yield* blobs.put(key, text);
    return text;
  });

  const summarizeWork = (facts: RepoFacts) =>
    Effect.map(
      readme(facts),
      (text): Work => ({
        _tag: "Summarize",
        prompt: {
          fullName: fullName(facts),
          description: facts.description,
          topics: facts.topics,
          language: facts.language,
          readme: text,
        },
      }),
    );

  const planOne = Effect.fn("EnrichRepo.planOne")(function* (
    row: Db.StoredRepo,
    facts: RepoFacts | undefined,
  ): Effect.fn.Return<Step<Job>, DbQueryFailed | DbRowInvalid> {
    const id = row.id;
    if (facts === undefined) return Result.fail(Enrichment.Gone({ id }));
    // saveFacts can clear pending, and nothing fetches a repo that is not pending, so the counts go first.
    yield* db.repos.saveCounts({ id: facts.id, stars: facts.stars, forks: facts.forks });
    const { pending } = yield* db.repos.saveFacts(storedFacts(facts));
    if (!pending) return Result.fail(Enrichment.Unchanged({ id }));
    const work = yield* Option.match(summaryOf(row, readmeOidOf(facts)), {
      onSome: (summary) => Effect.succeed(Result.succeed<Work>({ _tag: "Embed", summary })),
      onNone: () => Effect.result(summarizeWork(facts)),
    });
    return Result.isSuccess(work)
      ? Result.succeed({ id, facts, work: work.success })
      : Result.fail(Enrichment.Failed({ id, error: work.failure }));
  });

  const plan = Effect.fn("EnrichRepo.plan")(function* (ids: ReadonlyArray<RepoId>) {
    const rows = new Map<number, Db.StoredRepo>((yield* db.repos.getMany(ids)).map((row) => [row.id, row]));
    const now = yield* DateTime.now;
    const located = ids.map((id): Step<Db.StoredRepo & { readonly nodeId: NonNullable<Db.Repo["nodeId"]> }> => {
      const row = rows.get(id);
      if (row === undefined) return Result.fail(Enrichment.NotFound({ id }));
      if (!row.pending) return Result.fail(Enrichment.Unchanged({ id }));
      if (EnrichRetry.inBackoff(row, now)) return Result.fail(Enrichment.Backoff({ id }));
      if (row.nodeId === null) return Result.fail(Enrichment.NoNodeId({ id }));
      return Result.succeed({ ...row, nodeId: row.nodeId });
    });
    const nodeIds = located.flatMap((step) => (Result.isSuccess(step) ? [step.success.nodeId] : []));
    const facts = nodeIds.length === 0 ? [] : yield* github.repoFacts(nodeIds);
    const factsById = new Map<number, RepoFacts>(facts.map((entry) => [entry.id, entry]));
    // planOne saves the new README ID and homepage, so the icon work is decided from the rows as they were. A failed
    // send only logs, because the icon backfill later checks a never-checked icon and the 30-day refresh a changed one.
    yield* icons
      .send(
        located.flatMap((step) => {
          const found = Result.isSuccess(step) ? factsById.get(step.success.id) : undefined;
          return Result.isSuccess(step) && found !== undefined && needsIconCheck(step.success, found)
            ? [iconRequest(found)]
            : [];
        }),
      )
      .pipe(
        Effect.catchTags({
          IconQueueFailed: (error) =>
            Effect.logWarning("Icon send failed, enriching anyway", { messages: error.messages }),
        }),
      );
    return yield* Effect.forEach(
      located,
      (step) =>
        Result.isFailure(step)
          ? Effect.succeed(Result.fail(step.failure))
          : planOne(step.success, factsById.get(step.success.id)),
      { concurrency: planConcurrency },
    );
  });

  const keepSummary = (job: Job, answer: Result.Result<Summarize.RepoSummary, AiError>) =>
    Result.isFailure(answer)
      ? Effect.succeed(Result.fail(Enrichment.Failed({ id: job.id, error: answer.failure })))
      : guarded(job.id, db.repos.saveSummary({ id: job.id, readmeOid: readmeOidOf(job.facts), ...answer.success }), {
          job,
          summary: answer.success,
        });

  // Each summary is saved as its answer arrives, so work cut short keeps every summary already paid for.
  const summarizeAll = Effect.fn("EnrichRepo.summarizeAll")(function* (jobs: ReadonlyArray<Job>) {
    const stored = jobs.flatMap((job) =>
      job.work._tag === "Embed" ? [Result.succeed<Embeddable>({ job, summary: job.work.summary })] : [],
    );
    const asked = jobs.flatMap((job) => (job.work._tag === "Summarize" ? [{ job, facts: job.work.prompt }] : []));
    const answered = yield* Summarize.summarizeBatch(asked, ({ facts }) => facts).pipe(
      Stream.mapEffect(([{ job }, answer]) => keepSummary(job, answer), {
        concurrency: saveConcurrency,
        unordered: true,
      }),
      Stream.runCollect,
      Effect.provideService(TextGeneration.TextGeneration, textGeneration),
    );
    return [...stored, ...answered];
  });

  const keepEmbedding = (item: Embeddable, vector: Result.Result<Embedding, AiError>) => {
    const { job, summary } = item;
    if (Result.isFailure(vector))
      return Effect.succeed(Result.fail(Enrichment.Failed({ id: job.id, error: vector.failure })));
    const saved =
      job.work._tag === "Summarize"
        ? Enrichment.Summarized({ id: job.id, summary })
        : Enrichment.Embedded({ id: job.id, summary });
    return guarded(
      job.id,
      db.repos.saveEmbedding({
        id: job.id,
        embedding: vector.success,
        summary: summary.summary,
        readmeOid: readmeOidOf(job.facts),
      }),
      saved,
    );
  };

  // embed answers one vector per text, in text order, or fails the whole call.
  const embedChunk = (chunk: ReadonlyArray<Embeddable>) =>
    embeddings
      .embed(
        chunk.map(({ job, summary }) =>
          Summarize.embeddingText({ fullName: fullName(job.facts), description: job.facts.description }, summary),
        ),
      )
      .pipe(
        Effect.flatMap((output) => Effect.forEach(output, (vector) => Effect.orDie(decodeEmbedding(vector)))),
        Effect.map((output) => output.map((vector): Result.Result<Embedding, AiError> => Result.succeed(vector))),
        Effect.catch((error) => Effect.succeed(chunk.map((): Result.Result<Embedding, AiError> => Result.fail(error)))),
        Effect.flatMap((vectors) =>
          Effect.forEach(Arr.zip(chunk, vectors), ([item, vector]) => keepEmbedding(item, vector)),
        ),
      );

  const enrichChunk = Effect.fn("EnrichRepo.enrichChunk")(function* (ids: ReadonlyArray<RepoId>) {
    const [jobs, skipped] = Arr.separate(yield* plan(ids));
    const [summarized, unsummarized] = Arr.separate(yield* summarizeAll(jobs));
    const embedded = yield* Effect.forEach(Arr.chunksOf(summarized, embedBatchSize), embedChunk);
    const outcomes = [...skipped, ...unsummarized, ...embedded.flat().map(Result.merge)];
    yield* db.repos.recordEnrichFailures({
      ids: outcomes.flatMap((outcome) => (repoFailed(outcome) ? [outcome.id] : [])),
      at: yield* DateTime.now,
      retryDelays: EnrichRetry.retryDelays,
    });
    return outcomes;
  });

  const enrichRepos = Effect.fn("EnrichRepo.enrichRepos")(function* (ids: ReadonlyArray<RepoId>) {
    // Sorting keeps each chunk's contents the same from run to run, so a rerun sends the same batch
    // request and the Gateway's idempotency key finds the job that run already paid for.
    const chunks = Arr.chunksOf(Arr.sort(Arr.dedupe(ids), Order.Number), batchSize);
    const outcomes = yield* Effect.forEach(chunks, enrichChunk, { concurrency: batchConcurrency });
    const byId = new Map<number, Enrichment>(outcomes.flat().map((outcome) => [outcome.id, outcome]));
    return yield* Effect.forEach(ids, (id) => Effect.orDie(Effect.fromNullishOr(byId.get(id))));
  });

  return EnrichRepo.of({ enrichRepos });
});

export const layer = Layer.effect(EnrichRepo, make);
