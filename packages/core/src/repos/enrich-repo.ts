import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
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
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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

export type EnrichRepoAbort = DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch | GitHubError;

export class EnrichRepo extends Context.Service<
  EnrichRepo,
  {
    readonly enrichRepo: (
      id: RepoId,
    ) => Effect.Effect<Exclude<Enrichment, { readonly _tag: "Failed" }>, EnrichRepoError | EnrichRepoAbort>;
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

type Summarizer = (
  repos: ReadonlyArray<Summarize.RepoFacts>,
) => Effect.Effect<TextGeneration.BatchResults<Summarize.RepoSummary>, never, TextGeneration.TextGeneration>;

const batchSize = 250;
const batchConcurrency = 4;
const planConcurrency = 4;
const embedBatchSize = 128;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

export const readmeKey = (oid: ObjectId) => `readmes/${oid}`;

const readmeOidOf = (facts: RepoFacts) => facts.readme?.oid ?? null;

const summaryOf = (row: Db.Repo, readmeOid: ObjectId | null): Option.Option<Summary> =>
  row.summary !== null && row.summaryReadmeOid === readmeOid
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
});

const fullName = (facts: RepoFacts) => `${facts.owner}/${facts.name}`;

const answerAt = <A>(answers: ReadonlyArray<A>, index: number) => Effect.orDie(Effect.fromNullishOr(answers[index]));

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

  const readme = Effect.fn("EnrichRepo.readme")(function* (facts: RepoFacts) {
    if (facts.readme === null) return null;
    const key = readmeKey(facts.readme.oid);
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
    const steps = yield* Effect.forEach(
      located,
      (step) =>
        Result.isFailure(step)
          ? Effect.succeed(Result.fail(step.failure))
          : planOne(step.success, factsById.get(step.success.id)),
      { concurrency: planConcurrency },
    );
    const unreadable = steps.flatMap((step) =>
      Result.isFailure(step) && (step.failure._tag === "Gone" || step.failure._tag === "NoNodeId")
        ? [step.failure.id]
        : [],
    );
    yield* db.repos.recordEnrichFailures({ ids: unreadable, at: yield* DateTime.now });
    return steps;
  });

  const keepSummary = (job: Job, answer: Result.Result<Summarize.RepoSummary, AiError>) =>
    Result.isFailure(answer)
      ? Effect.succeed(Result.fail(Enrichment.Failed({ id: job.id, error: answer.failure })))
      : guarded(job.id, db.repos.saveSummary({ id: job.id, readmeOid: readmeOidOf(job.facts), ...answer.success }), {
          job,
          summary: answer.success,
        });

  const summarizeAll = Effect.fn("EnrichRepo.summarizeAll")(function* (
    steps: ReadonlyArray<Step<Job>>,
    summarizer: Summarizer,
  ) {
    const asked = steps.flatMap((step) =>
      Result.isSuccess(step) && step.success.work._tag === "Summarize" ? [step.success.work.prompt] : [],
    );
    const answers =
      asked.length === 0
        ? []
        : yield* summarizer(asked).pipe(Effect.provideService(TextGeneration.TextGeneration, textGeneration));
    let next = 0;
    return yield* Effect.forEach(steps, (step): Effect.Effect<Step<Embeddable>, DbQueryFailed> => {
      if (Result.isFailure(step)) return Effect.succeed(Result.fail(step.failure));
      const job = step.success;
      if (job.work._tag === "Embed") return Effect.succeed(Result.succeed({ job, summary: job.work.summary }));
      return Effect.flatMap(answerAt(answers, next++), (answer) => keepSummary(job, answer));
    });
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

  const embedAll = Effect.fn("EnrichRepo.embedAll")(function* (steps: ReadonlyArray<Step<Embeddable>>) {
    const open = steps.flatMap((step) => (Result.isSuccess(step) ? [step.success] : []));
    const vectors = (yield* Effect.forEach(Arr.chunksOf(open, embedBatchSize), (chunk) =>
      embeddings
        .embed(
          chunk.map(({ job, summary }) =>
            Summarize.embeddingText({ fullName: fullName(job.facts), description: job.facts.description }, summary),
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
          : Effect.flatMap(answerAt(vectors, next++), (vector) => keepEmbedding(step.success, vector)),
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
    const byId = new Map<number, Enrichment>(outcomes.flat().map((outcome) => [outcome.id, outcome]));
    return yield* Effect.forEach(ids, (id) => Effect.orDie(Effect.fromNullishOr(byId.get(id))));
  });

  return EnrichRepo.of({ enrichRepo, enrichRepos });
});

export const layer = Layer.effect(EnrichRepo, make);
