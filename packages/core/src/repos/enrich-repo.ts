import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { ObjectId, RepoFacts, RepoId, RepoNodeId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as BlobStore from "./blob-store.ts";

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
  Stale: { readonly id: RepoId };
  Failed: { readonly id: RepoId; readonly error: EnrichRepoError };
  Summarized: { readonly id: RepoId; readonly summary: Summary };
  Embedded: { readonly id: RepoId; readonly summary: Summary };
}>;
export const Enrichment = Data.taggedEnum<Enrichment>();

export type ChunkError = DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch | GitHubError;

export class EnrichRepo extends Context.Service<
  EnrichRepo,
  {
    readonly enrichRepo: (
      id: RepoId,
    ) => Effect.Effect<Exclude<Enrichment, { readonly _tag: "Failed" }>, EnrichRepoError | ChunkError>;
    readonly enrichRepos: (ids: ReadonlyArray<RepoId>) => Effect.Effect<ReadonlyArray<Enrichment>, ChunkError>;
  }
>()("@stargrep/core/repos/enrich-repo/EnrichRepo") {}

type Work = { readonly _tag: "Embed"; readonly summary: Summary } | { readonly _tag: "Summarize" };

interface Job {
  readonly id: RepoId;
  readonly facts: RepoFacts;
  readonly work: Work;
}

interface Prompted {
  readonly job: Job;
  readonly prompt: Summarize.RepoFacts | null;
}

interface Embeddable {
  readonly id: RepoId;
  readonly facts: RepoFacts;
  readonly summary: Summary;
  readonly fresh: boolean;
}

type Step<A> = Result.Result<A, Enrichment>;

type Summarizer = (
  repos: ReadonlyArray<Summarize.RepoFacts>,
) => Effect.Effect<TextGeneration.BatchResults<Summarize.RepoSummary>, AiError, TextGeneration.TextGeneration>;

const batchSize = 250;
const batchConcurrency = 4;
const embedBatchSize = 128;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

export const readmeKey = (oid: ObjectId) => `readmes/${oid}`;

const readmeOidOf = (facts: RepoFacts) => facts.readme?.oid ?? null;

const pendingWork = (row: Db.Repo, readmeOid: ObjectId | null): Option.Option<Work> => {
  if (row.summary === null || row.summaryReadmeOid !== readmeOid) return Option.some({ _tag: "Summarize" });
  if (row.embeddingModel === null) {
    return Option.some({ _tag: "Embed", summary: { summary: row.summary, keywords: row.keywords, kind: row.kind } });
  }
  return Option.none();
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

const answerAt = <A>(answers: ReadonlyArray<A>, index: number) => Effect.orDie(Effect.fromNullishOr(answers[index]));

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const blobs = yield* BlobStore.BlobStore;
  const embeddings = yield* Embeddings.Embeddings;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const readme = Effect.fn("EnrichRepo.readme")(function* (facts: RepoFacts) {
    if (facts.readme === null) return null;
    const key = readmeKey(facts.readme.oid);
    const stored = yield* blobs.get(key);
    if (Option.isSome(stored)) return stored.value;
    const text = yield* github.readme({ owner: facts.owner, name: facts.name, oid: facts.readme.oid });
    yield* blobs.put(key, text);
    return text;
  });

  const promptFacts = (facts: RepoFacts) =>
    Effect.map(
      readme(facts),
      (text): Summarize.RepoFacts => ({
        fullName: fullName(facts),
        description: facts.description,
        topics: facts.topics,
        language: facts.language,
        readme: text,
      }),
    );

  const plan = Effect.fn("EnrichRepo.plan")(function* (ids: ReadonlyArray<RepoId>) {
    const rows = new Map<number, Db.Repo>((yield* db.repos.getMany(ids)).map((row) => [row.id, row]));
    const located = ids.map((id): Step<{ readonly row: Db.Repo; readonly nodeId: RepoNodeId }> => {
      const row = rows.get(id);
      if (row === undefined) return Result.fail(Enrichment.NotFound({ id }));
      if (Option.isNone(pendingWork(row, row.readmeOid))) return Result.fail(Enrichment.Unchanged({ id }));
      if (row.nodeId === null) return Result.fail(Enrichment.NoNodeId({ id }));
      return Result.succeed({ row, nodeId: row.nodeId });
    });
    const nodeIds = located.flatMap((step) => (Result.isSuccess(step) ? [step.success.nodeId] : []));
    const facts = nodeIds.length === 0 ? [] : yield* github.repoFacts(nodeIds);
    const factsById = new Map<number, RepoFacts>(facts.map((entry) => [entry.id, entry]));
    return yield* Effect.forEach(located, (step) =>
      Effect.gen(function* (): Effect.fn.Return<Step<Job>, DbQueryFailed> {
        if (Result.isFailure(step)) return Result.fail(step.failure);
        const { row } = step.success;
        const entry = factsById.get(row.id);
        if (entry === undefined) return Result.fail(Enrichment.Gone({ id: row.id }));
        yield* db.repos.saveFacts(storedFacts(entry));
        return Option.match(pendingWork(row, readmeOidOf(entry)), {
          onNone: () => Result.fail(Enrichment.Unchanged({ id: row.id })),
          onSome: (work) => Result.succeed({ id: row.id, facts: entry, work }),
        });
      }),
    );
  });

  const keepSummary = Effect.fn("EnrichRepo.keepSummary")(function* (
    job: Job,
    answer: Result.Result<Summarize.RepoSummary, AiError>,
  ): Effect.fn.Return<Step<Embeddable>, DbQueryFailed> {
    if (Result.isFailure(answer)) return Result.fail(Enrichment.Failed({ id: job.id, error: answer.failure }));
    const applied = yield* db.repos
      .saveSummary({ id: job.id, readmeOid: readmeOidOf(job.facts), ...answer.success })
      .pipe(Effect.catchTags({ RepoNotFound: () => Effect.succeed(null) }));
    if (applied === null) return Result.fail(Enrichment.NotFound({ id: job.id }));
    if (!applied) return Result.fail(Enrichment.Stale({ id: job.id }));
    return Result.succeed({ id: job.id, facts: job.facts, summary: answer.success, fresh: true });
  });

  const summarizeAll = Effect.fn("EnrichRepo.summarizeAll")(function* (
    steps: ReadonlyArray<Step<Job>>,
    summarizer: Summarizer,
  ) {
    const prompted = yield* Effect.forEach(steps, (step): Effect.Effect<Step<Prompted>> => {
      if (Result.isFailure(step)) return Effect.succeed(Result.fail(step.failure));
      const job = step.success;
      if (job.work._tag === "Embed") return Effect.succeed(Result.succeed({ job, prompt: null }));
      return promptFacts(job.facts).pipe(
        Effect.map((prompt) => Result.succeed({ job, prompt })),
        Effect.catch((error) => Effect.succeed(Result.fail(Enrichment.Failed({ id: job.id, error })))),
      );
    });
    const asked = prompted.flatMap((step) =>
      Result.isSuccess(step) && step.success.prompt !== null ? [step.success.prompt] : [],
    );
    const answers =
      asked.length === 0
        ? []
        : yield* summarizer(asked).pipe(
            Effect.provideService(TextGeneration.TextGeneration, textGeneration),
            Effect.catch((error) => Effect.succeed(asked.map(() => Result.fail(error)))),
          );
    let next = 0;
    return yield* Effect.forEach(prompted, (step): Effect.Effect<Step<Embeddable>, DbQueryFailed> => {
      if (Result.isFailure(step)) return Effect.succeed(Result.fail(step.failure));
      const { job } = step.success;
      if (job.work._tag === "Embed") {
        return Effect.succeed(
          Result.succeed({ id: job.id, facts: job.facts, summary: job.work.summary, fresh: false }),
        );
      }
      return Effect.flatMap(answerAt(answers, next++), (answer) => keepSummary(job, answer));
    });
  });

  const keepEmbedding = Effect.fn("EnrichRepo.keepEmbedding")(function* (
    item: Embeddable,
    vector: Result.Result<Embedding, AiError>,
  ): Effect.fn.Return<Enrichment, DbQueryFailed | EmbeddingModelMismatch> {
    if (Result.isFailure(vector)) return Enrichment.Failed({ id: item.id, error: vector.failure });
    const applied = yield* db.repos
      .saveEmbedding({
        id: item.id,
        embedding: vector.success,
        summary: item.summary.summary,
        summaryReadmeOid: readmeOidOf(item.facts),
      })
      .pipe(Effect.catchTags({ RepoNotFound: () => Effect.succeed(null) }));
    if (applied === null) return Enrichment.NotFound({ id: item.id });
    if (!applied) return Enrichment.Stale({ id: item.id });
    return item.fresh
      ? Enrichment.Summarized({ id: item.id, summary: item.summary })
      : Enrichment.Embedded({ id: item.id, summary: item.summary });
  });

  const embedAll = Effect.fn("EnrichRepo.embedAll")(function* (steps: ReadonlyArray<Step<Embeddable>>) {
    const open = steps.flatMap((step) => (Result.isSuccess(step) ? [step.success] : []));
    const vectors = (yield* Effect.forEach(Arr.chunksOf(open, embedBatchSize), (chunk) =>
      embeddings
        .embed(
          chunk.map((item) =>
            Summarize.embeddingText(
              { fullName: fullName(item.facts), description: item.facts.description },
              item.summary,
            ),
          ),
        )
        .pipe(
          Effect.flatMap((output) => Effect.forEach(output, (vector) => Effect.orDie(decodeEmbedding(vector)))),
          Effect.map((output) => output.map((vector) => Result.succeed<Embedding>(vector))),
          Effect.catch((error) => Effect.succeed(chunk.map(() => Result.fail<AiError>(error)))),
        ),
    )).flat();
    let next = 0;
    return yield* Effect.forEach(
      steps,
      (step): Effect.Effect<Step<Enrichment>, DbQueryFailed | EmbeddingModelMismatch> =>
        Result.isFailure(step)
          ? Effect.succeed(Result.fail(step.failure))
          : Effect.map(
              Effect.flatMap(answerAt(vectors, next++), (vector) => keepEmbedding(step.success, vector)),
              Result.succeed,
            ),
    );
  });

  const enrichChunk = Effect.fn("EnrichRepo.enrichChunk")(function* (
    ids: ReadonlyArray<RepoId>,
    summarizer: Summarizer,
  ) {
    const planned = yield* plan(ids);
    const summarized = yield* summarizeAll(planned, summarizer);
    const steps = yield* embedAll(summarized);
    return steps.map(Result.merge);
  });

  const summarizeEach: Summarizer = (repos) =>
    Effect.forEach(repos, (facts) => Effect.result(Summarize.summarize(facts)));

  const enrichRepo = Effect.fn("EnrichRepo.enrichRepo")(function* (id: RepoId) {
    const outcome = yield* answerAt(yield* enrichChunk([id], summarizeEach), 0);
    if (outcome._tag === "Failed") return yield* outcome.error;
    return outcome;
  });

  const enrichRepos = Effect.fn("EnrichRepo.enrichRepos")(function* (ids: ReadonlyArray<RepoId>) {
    // Sorting keeps each chunk's contents the same from run to run, so a rerun sends the same batch
    // request and the Gateway's idempotency key finds the job that run already paid for.
    const chunks = Arr.chunksOf(Arr.sort(Arr.dedupe(ids), Order.Number), batchSize);
    const outcomes = yield* Effect.forEach(chunks, (chunk) => enrichChunk(chunk, Summarize.summarizeBatch), {
      concurrency: batchConcurrency,
    });
    return outcomes.flat();
  });

  return EnrichRepo.of({ enrichRepo, enrichRepos });
});

export const layer = Layer.effect(EnrichRepo, make);
