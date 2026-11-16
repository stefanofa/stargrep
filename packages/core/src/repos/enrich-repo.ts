import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
import * as Models from "@stargrep/ai/models";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Analytics from "@stargrep/analytics/analytics";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import { type GitHubError, isPermanent } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { ObjectId, RepoFacts, RepoId } from "@stargrep/github/schemas";
import type { InputHash } from "@stargrep/knowledge/ids";
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
import * as RepoKnowledge from "../knowledge/repo-knowledge.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichRetry from "./enrich-retry.ts";

export interface Summary {
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
}

// A paid answer that commit A could not save. It fails only its own repo. refused says the database refused the answer
// itself, which would happen again, so it counts as the repo's failure and an answer that can never be saved reaches
// the cap. A save that failed for a reason any repo could hit, such as a lock timeout, a lost connection, or a
// deadlock, does not count.
export class AnswerNotSaved extends Schema.TaggedError<AnswerNotSaved, { readonly brand: unique symbol }>()(
  "AnswerNotSaved",
  {
    reason: Schema.String,
    sqlState: Schema.NullOr(Schema.String),
    refused: Schema.Boolean,
  },
) {
  override get message(): string {
    return `The answer was paid for and not saved: ${this.reason}${this.sqlState === null ? "" : ` ${this.sqlState}`}`;
  }
}

export type EnrichRepoError = AiError | GitHubError | BlobStore.BlobStoreFailed | AnswerNotSaved;

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
export const ownError = (error: EnrichRepoError): boolean =>
  Match.valueTags(error, {
    NotFound: () => true,
    GitHubRequestFailed: isPermanent,
    GitHubResponseInvalid: isPermanent,
    // A summary answer is one paid call for one repo, so a repo whose answers never decode must reach the cap. An
    // embedding answer covers a whole batch, so its bad shape is the provider's fault, not any one repo's.
    AiOutputInvalid: (failure) => failure.operation === "generate",
    AiRefused: () => true,
    AnswerNotSaved: (failure) => failure.refused,
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

// How a failed paid summary call ends the attempt's lease. A save that failed for a reason any repo could hit keeps its
// lease, so the repo waits it out and the sweep sends it again, as for a run cut short. A refusal would come again on
// every call for the same prompt, so it caps the repo at once. Otherwise the failure is counted and backs the repo off,
// or the lease is given back.
export const settlement = (error: EnrichRepoError): Db.FailureSettlement | "keep" => {
  if (error._tag === "AnswerNotSaved" && !error.refused) return "keep";
  if (error._tag === "AiRefused") return "cap";
  return ownError(error) ? "count" : "release";
};

// What an attempt logs about a failed repo: the failure's tag, whether it counts toward the cap, and the error's own
// message, which carries short facts such as a status or a model name and never README text, prompts, model output,
// or keys.
interface Failure {
  readonly error: string;
  readonly counts: boolean;
  readonly detail?: string;
}

const failureOf = (outcome: Enrichment): Option.Option<Failure> =>
  Enrichment.$match(outcome, {
    Gone: () => Option.some({ error: "Gone", counts: true }),
    NoNodeId: () => Option.some({ error: "NoNodeId", counts: true }),
    Failed: ({ error }) => Option.some({ error: error._tag, counts: ownError(error), detail: error.message }),
    Unchanged: () => Option.none(),
    NotFound: () => Option.none(),
    Backoff: () => Option.none(),
    Stale: () => Option.none(),
    Summarized: () => Option.none(),
    Embedded: () => Option.none(),
  });

const repoFailed = (outcome: Enrichment): boolean => Option.exists(failureOf(outcome), (failure) => failure.counts);

const logFailures = (outcomes: ReadonlyArray<Enrichment>) =>
  Effect.forEach(
    outcomes,
    (outcome) =>
      Option.match(failureOf(outcome), {
        onNone: () => Effect.void,
        onSome: (failure) => Effect.logWarning("Enrichment failed", { repoId: outcome.id, ...failure }),
      }),
    { discard: true },
  );

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
  // The prompt inputs these facts make, as saveFacts saved them, which an answer must carry to be saved.
  readonly inputHash: InputHash;
  readonly work: Work;
}

// A pending repo's saved facts, with its saved summary when that is current, before any README is read.
interface Planned {
  readonly id: RepoId;
  readonly facts: RepoFacts;
  readonly inputHash: InputHash;
  readonly summary: Option.Option<Summary>;
}

interface ReadmeFile {
  readonly facts: RepoFacts;
  readonly oid: ObjectId;
}

type ReadmeRead = Result.Result<string, GitHubError | BlobStore.BlobStoreFailed>;

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

// The saved summary, when it answers the current recipe, README, and prompt inputs, so only its embedding is due.
const summaryOf = (row: Db.StoredRepo, readmeOid: ObjectId | null, inputHash: InputHash): Option.Option<Summary> =>
  row.summary !== null &&
  row.summaryReadmeOid === readmeOid &&
  row.summaryRecipe === Models.summaryRecipe &&
  row.summaryInputHash === inputHash
    ? Option.some({ summary: row.summary, keywords: row.keywords })
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

// A repo with no README has no read, and summarizes without one.
const jobOf = ({ summary, ...job }: Planned, readme: ReadmeRead | undefined): Step<Job> =>
  Option.match(summary, {
    onSome: (current) => Result.succeed({ ...job, work: { _tag: "Embed", summary: current } }),
    onNone: () =>
      Result.match(readme ?? Result.succeed(null), {
        onFailure: (error) => Result.fail(Enrichment.Failed({ id: job.id, error })),
        onSuccess: (text) =>
          Result.succeed({
            ...job,
            work: {
              _tag: "Summarize",
              prompt: {
                fullName: fullName(job.facts),
                description: job.facts.description,
                topics: job.facts.topics,
                language: job.facts.language,
                readme: text,
              },
            },
          }),
      }),
  });

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

  // One read per file, in order. A README that cannot be read fails only its own repo.
  const readmes = Effect.fn("EnrichRepo.readmes")(function* (files: ReadonlyArray<ReadmeFile>) {
    const stored = Arr.zip(
      files,
      yield* Effect.forEach(files, ({ oid }) => Effect.result(blobs.get(BlobStore.readmeKey(oid))), {
        concurrency: planConcurrency,
      }),
    );
    const missing = stored.flatMap(([file, text]) =>
      Result.isSuccess(text) && Option.isNone(text.success) ? [{ nodeId: file.facts.nodeId, oid: file.oid }] : [],
    );
    const fetched =
      missing.length === 0
        ? Result.succeed(new Map<ObjectId, string>())
        : yield* Effect.result(github.readmes(missing));
    const fromGitHub = ({ facts, oid }: ReadmeFile) =>
      Effect.fromResult(fetched).pipe(
        Effect.flatMap((texts) =>
          Option.match(Option.fromUndefinedOr(texts.get(oid)), {
            onSome: Effect.succeed,
            onNone: () => github.readme({ owner: facts.owner, name: facts.name, oid }),
          }),
        ),
        Effect.tap((text) => blobs.put(BlobStore.readmeKey(oid), text)),
      );
    return yield* Effect.forEach(
      stored,
      ([file, text]) =>
        Effect.result(
          Effect.fromResult(text).pipe(
            Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fromGitHub(file) })),
          ),
        ),
      { concurrency: planConcurrency },
    );
  });

  const planOne = Effect.fn("EnrichRepo.planOne")(function* (
    row: Db.StoredRepo,
    facts: RepoFacts | undefined,
  ): Effect.fn.Return<Step<Planned>, DbQueryFailed | DbRowInvalid> {
    const id = row.id;
    if (facts === undefined) return Result.fail(Enrichment.Gone({ id }));
    // saveFacts can clear pending, and nothing fetches a repo that is not pending, so the counts go first.
    yield* db.repos.saveCounts({ id: facts.id, stars: facts.stars, forks: facts.forks });
    const { pending, inputHash } = yield* db.repos.saveFacts(storedFacts(facts));
    if (!pending) return Result.fail(Enrichment.Unchanged({ id }));
    return Result.succeed({ id, facts, inputHash, summary: summaryOf(row, readmeOidOf(facts), inputHash) });
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
    const planned = yield* Effect.forEach(
      located,
      (step) =>
        Result.isFailure(step)
          ? Effect.succeed(Result.fail(step.failure))
          : planOne(step.success, factsById.get(step.success.id)),
      { concurrency: planConcurrency },
    );
    // Every README the due summaries need is read at once, so GraphQL can read them in batches.
    const files = planned.flatMap((step) =>
      Result.isSuccess(step) && Option.isNone(step.success.summary) && step.success.facts.readme !== null
        ? [{ facts: step.success.facts, oid: step.success.facts.readme.oid }]
        : [],
    );
    const texts = new Map(
      Arr.zip(
        files.map(({ facts }) => facts.id),
        yield* readmes(files),
      ),
    );
    return planned.map((step) => Result.flatMap(step, (job) => jobOf(job, texts.get(job.id))));
  });

  // Commit A for a paid answer, as soon as it arrives. Capture gives the attempt's lease back when it saves or keeps
  // the answer as history. An answer it cannot save fails only its own repo.
  const keepSummary = Effect.fnUntraced(function* (
    job: Job,
    answer: Result.Result<Summarize.RepoSummary, AiError>,
    lease: DateTime.Utc,
  ): Effect.fn.Return<Step<Embeddable>> {
    if (Result.isFailure(answer)) return Result.fail(Enrichment.Failed({ id: job.id, error: answer.failure }));
    const captured = yield* RepoKnowledge.capture([
      {
        repoId: job.id,
        readmeOid: readmeOidOf(job.facts),
        inputHash: job.inputHash,
        source: textGeneration.provider === "fake" ? "stand-in" : "model",
        model: textGeneration.model,
        answer: answer.success,
        lease,
      },
    ]).pipe(
      Effect.provideService(Db.Db, db),
      Effect.map(Arr.head),
      Effect.catchTags({
        DbQueryFailed: (error) =>
          Effect.fail(
            new AnswerNotSaved({
              reason: error.reason,
              sqlState: error.sqlState,
              refused: error.reason === "query" || error.reason === "constraint",
            }),
          ),
        DbRowInvalid: (error) => Effect.fail(new AnswerNotSaved({ reason: error._tag, sqlState: null, refused: true })),
      }),
      Effect.result,
    );
    if (Result.isFailure(captured)) return Result.fail(Enrichment.Failed({ id: job.id, error: captured.failure }));
    const outcome = Option.getOrUndefined(captured.success);
    if (outcome?._tag === "Saved") {
      yield* Analytics.capture(Analytics.Event.SummaryGenerated({ model: textGeneration.model }));
      return Result.succeed({ job, summary: { summary: outcome.summary, keywords: outcome.keywords } });
    }
    return Result.fail(
      outcome?._tag === "NotFound" ? Enrichment.NotFound({ id: job.id }) : Enrichment.Stale({ id: job.id }),
    );
  });

  // Each summary is saved as its answer arrives, so work cut short keeps every summary already paid for. A repo is
  // asked about only once this attempt holds its lease, so two attempts never pay for one repo, and a repo another
  // attempt holds or whose summary is no longer due is skipped. Failed calls are settled while the attempt still holds
  // their leases, then the saved repos are projected together, taking the vocabulary locks once for the chunk. It returns
  // the summaries to embed, and as settled the held repos and every failed answer, which settleFailures has recorded.
  const summarizeAll = Effect.fn("EnrichRepo.summarizeAll")(function* (
    jobs: ReadonlyArray<Job>,
    projector: RepoKnowledge.Projector,
  ) {
    const stored = jobs.flatMap((job) => (job.work._tag === "Embed" ? [{ job, summary: job.work.summary }] : []));
    const due = jobs.flatMap((job) => (job.work._tag === "Summarize" ? [{ job, facts: job.work.prompt }] : []));
    const now = yield* DateTime.now;
    const until = DateTime.addDuration(now, EnrichRetry.leaseFor(textGeneration.batchTimeout, due.length));
    const leased = new Set<number>(yield* db.repos.lease({ ids: due.map(({ job }) => job.id), now, until }));
    const asked = due.filter(({ job }) => leased.has(job.id));
    const held = due.filter(({ job }) => !leased.has(job.id));
    const [answered, ended] = Arr.separate(
      yield* Summarize.summarizeBatch(asked, ({ facts }) => facts).pipe(
        Stream.mapEffect(([{ job }, answer]) => keepSummary(job, answer, until), {
          concurrency: saveConcurrency,
          unordered: true,
        }),
        Stream.runCollect,
        Effect.provideService(TextGeneration.TextGeneration, textGeneration),
      ),
    );
    yield* db.repos.settleFailures({
      until,
      failures: ended.flatMap((outcome) => {
        if (outcome._tag !== "Failed") return [];
        const settled = settlement(outcome.error);
        return settled === "keep" ? [] : [{ id: outcome.id, settled }];
      }),
      at: yield* DateTime.now,
      retryDelays: EnrichRetry.retryDelays,
    });
    yield* projector.projectSaved(answered.map(({ job }) => job.id));
    return {
      embeddable: [...stored, ...answered],
      settled: [...held.map(({ job }) => Enrichment.Backoff({ id: job.id })), ...ended],
    };
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
        owner: job.facts.owner,
        name: job.facts.name,
        embedding: vector.success,
        summary: summary.summary,
        keywords: summary.keywords,
        description: job.facts.description,
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

  const enrichChunk = Effect.fn("EnrichRepo.enrichChunk")(function* (
    ids: ReadonlyArray<RepoId>,
    projector: RepoKnowledge.Projector,
  ) {
    const [jobs, skipped] = Arr.separate(yield* plan(ids));
    const { embeddable, settled } = yield* summarizeAll(jobs, projector);
    const embedded = (yield* Effect.forEach(Arr.chunksOf(embeddable, embedBatchSize), embedChunk))
      .flat()
      .map(Result.merge);
    const outcomes = [...skipped, ...settled, ...embedded];
    yield* logFailures(outcomes);
    // settleFailures recorded the summary phase's failures, so only the other phases' are recorded here.
    yield* db.repos.recordEnrichFailures({
      ids: [...skipped, ...embedded].flatMap((outcome) => (repoFailed(outcome) ? [outcome.id] : [])),
      at: yield* DateTime.now,
      retryDelays: EnrichRetry.retryDelays,
    });
    return outcomes;
  });

  const enrichRepos = Effect.fn("EnrichRepo.enrichRepos")(function* (ids: ReadonlyArray<RepoId>) {
    // One projector for the run, so its chunks read the vocabulary rules again only when a decision lands.
    const projector = yield* RepoKnowledge.projector.pipe(Effect.provideService(Db.Db, db));
    // Sorting keeps each chunk's contents the same from run to run. A rerun after a dead batch run's lease has run out
    // then sends the same batch request, and the Gateway's idempotency key can find the job that run already paid for. A
    // rerun inside the lease skips the repos it holds.
    const chunks = Arr.chunksOf(Arr.sort(Arr.dedupe(ids), Order.Number), batchSize);
    const outcomes = yield* Effect.forEach(chunks, (chunk) => enrichChunk(chunk, projector), {
      concurrency: batchConcurrency,
    });
    const byId = new Map<number, Enrichment>(outcomes.flat().map((outcome) => [outcome.id, outcome]));
    return yield* Effect.forEach(ids, (id) => Effect.orDie(Effect.fromNullishOr(byId.get(id))));
  });

  return EnrichRepo.of({ enrichRepos });
});

export const layer = Layer.effect(EnrichRepo, make);
