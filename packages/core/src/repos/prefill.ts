import * as Batches from "@stargrep/ai/batches";
import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiOutputInvalid, AiRequestFailed } from "@stargrep/ai/errors";
import { summaryRecipe } from "@stargrep/ai/models";
import { countTokens } from "@stargrep/ai/port";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Db from "@stargrep/db";
import { Embedding, type EmbeddingModelMismatch } from "@stargrep/db/embedding";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { type GitHubError, isPermanent } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { Login, ObjectId, type RepoFacts, RepoId, RepoName } from "@stargrep/github/schemas";
import { BatchId, InputHash } from "@stargrep/knowledge/ids";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RepoKnowledge from "../knowledge/repo-knowledge.ts";
import * as BlobStore from "./blob-store.ts";
import { AnswerNotSaved, settlement } from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";

// The lease a prefill batch holds, longer than the Gateway's 24-hour batch window, so no sweep or consumer finds one of
// its repos due while the batch is open. A driver waiting on a batch renews it every leaseRenewal, and resume moves it
// forward too.
export const batchLease = Duration.hours(26);
export const leaseRenewal = Duration.hours(1);
// A batch still unanswered after the provider's window and an hour more is left open for a later run.
export const collectDeadline = Duration.hours(25);
// A driver holds the prefill while its heartbeat is fresh. A crashed driver's claim goes stale after ownerStale.
export const ownerHeartbeat = Duration.seconds(15);
export const ownerStale = Duration.minutes(1);
// Capture flushes a group when it reaches any of these, so one commit A and one commit B cover each group.
export const groupRows = 64;
export const groupBytes = 1_000_000;
export const groupDeadline = Duration.seconds(2);
// CLI prompts asked at once, READMEs read at once per chunk, and embedding saves sent at once per group.
const directConcurrency = 4;
const readmeConcurrency = 4;
const embedSaveConcurrency = 4;

// What the request object holds: the exact request, and for each item what capture and embedding need. Resume reads
// it back instead of rebuilding prompts from facts that may have moved since.
const StoredItem = Schema.Struct({
  repoId: RepoId,
  inputHash: InputHash,
  readmeOid: Schema.NullOr(ObjectId),
  owner: Login,
  name: RepoName,
  description: Schema.NullOr(Schema.String),
  input: Schema.Struct({
    fullName: Schema.String,
    description: Schema.String,
    topics: Schema.Array(Schema.String),
    readme: Schema.String,
  }),
});
type StoredItem = typeof StoredItem.Type;

export const StoredRequest = Schema.Struct({ request: Batches.BatchRequest, items: Schema.Array(StoredItem) });
export type StoredRequest = typeof StoredRequest.Type;

const StoredJson = Schema.fromJsonString(StoredRequest);
const encodeStored = Schema.encodeEffect(StoredJson);
const decodeStored = Schema.decodeUnknownOption(StoredJson);
const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

export const requestObjectKey = (requestKey: string) => `prefill/requests/${requestKey}.json`;

// What became of one repo in a run.
export const outcomes = [
  // Already summarized under the current recipe, or gone, so the run made no GitHub call for it.
  "done",
  // GitHub resolved no public repo with the archive's ID under its name.
  "unresolved",
  // Its README could not be read, for a reason of its own.
  "unreadable",
  // Its facts are saved, and another attempt holds it or no summary is due.
  "held",
  // Its answer is saved.
  "saved",
  // Its answer is kept as history only, because its README or inputs moved on while the batch was open.
  "stale",
  // Its answer failed and is settled: counted against the repo, or its lease given back.
  "failed",
  // It still holds its manifest's lease, so the next run resumes it.
  "waiting",
] as const;
export type Outcome = (typeof outcomes)[number];

export interface ItemUsage {
  readonly repoId: RepoId;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

// How long one manifest took from its answers in hand to closed, for the pilot's writes gate.
export interface CaptureTime {
  readonly items: number;
  readonly seconds: number;
}

export interface PrefillReport {
  readonly outcomes: ReadonlyMap<RepoId, Outcome>;
  readonly unresolved: ReadonlyArray<GitHub.Unresolved>;
  readonly manifests: {
    readonly resumed: number;
    readonly dropped: number;
    readonly created: number;
    readonly closed: number;
    // Fallback manifests: second batches for items the first answered badly.
    readonly fallbacks: number;
    // Open manifests whose stored request is missing or does not match their key. They are kept, never given back,
    // so restoring the object resumes them, and their leases run out on their own if nobody does.
    readonly stuck: ReadonlyArray<BatchId>;
  };
  // Tokens each batch answer used, as the provider reported them.
  readonly usage: ReadonlyArray<ItemUsage>;
  // Repos whose first batch answer was missing or did not decode, so a fallback batch asked them again.
  readonly retried: ReadonlyArray<RepoId>;
  // Items paid for a second time: a resend the provider answered with a new batch instead of the recorded one, or a
  // CLI prompt asked again after a crash, which no provider can deduplicate.
  readonly repaid: number;
  readonly captures: ReadonlyArray<CaptureTime>;
}

// What a run has done so far. A caller that passes its own can still report a run that was interrupted.
export interface Progress {
  readonly outcomes: Map<RepoId, Outcome>;
  readonly unresolved: Array<GitHub.Unresolved>;
  readonly usage: Array<ItemUsage>;
  readonly counts: { resumed: number; dropped: number; created: number; closed: number; fallbacks: number };
  readonly stuck: Array<BatchId>;
  readonly retried: Array<RepoId>;
  readonly captures: Array<CaptureTime>;
  repaid: number;
}

export const progress = (): Progress => ({
  outcomes: new Map(),
  unresolved: [],
  usage: [],
  counts: { resumed: 0, dropped: 0, created: 0, closed: 0, fallbacks: 0 },
  stuck: [],
  retried: [],
  captures: [],
  repaid: 0,
});

export const reportOf = (done: Progress): PrefillReport => ({
  outcomes: done.outcomes,
  unresolved: done.unresolved,
  manifests: { ...done.counts, stuck: done.stuck },
  usage: done.usage,
  retried: done.retried,
  repaid: done.repaid,
  captures: done.captures,
});

export interface PrefillOptions {
  readonly refs: ReadonlyArray<GitHub.ArchiveRef>;
  readonly adapter: Db.BatchAdapter;
  readonly chunk: number;
  readonly concurrency: number;
  readonly progress?: Progress;
}

// Another driver holds the prefill and its heartbeat is fresh.
export class PrefillBusy extends Schema.TaggedError<PrefillBusy, { readonly brand: unique symbol }>()(
  "PrefillBusy",
  {},
) {
  override get message(): string {
    return "Another prefill driver is running against this database";
  }
}

// This driver's claim went stale and another took the prefill, so it stops before it touches a manifest again.
export class PrefillOwnershipLost extends Schema.TaggedError<PrefillOwnershipLost, { readonly brand: unique symbol }>()(
  "PrefillOwnershipLost",
  {},
) {
  override get message(): string {
    return "This prefill driver lost the prefill to another driver";
  }
}

export type PrefillAbort =
  | DbQueryFailed
  | DbRowInvalid
  | GitHubError
  | BlobStore.BlobStoreFailed
  | EmbeddingModelMismatch
  | PrefillBusy
  | PrefillOwnershipLost;

export class Prefill extends Context.Service<
  Prefill,
  {
    readonly run: (options: PrefillOptions) => Effect.Effect<PrefillReport, PrefillAbort>;
  }
>()("@stargrep/core/repos/prefill") {}

// One item of a request: the prompt sent, and what capture and embedding need about it.
interface Item {
  readonly stored: StoredItem;
  readonly text: string;
}

interface Answered {
  readonly item: StoredItem;
  readonly answer: Result.Result<Summarize.RepoSummary, AiError>;
  readonly direct: boolean;
}

const newId = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.provide(SecureRandom.layerWebCrypto),
);

// GitHub names when a spent budget or a rate limit lifts, and the prefill waits for it rather than give up a chunk.
const budgetRetry = {
  schedule: Schedule.spaced(Duration.seconds(1)).pipe(
    Schedule.setInputType<GitHubError>(),
    Schedule.modifyDelay(({ duration, input }) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (input._tag === "TokenBudgetExhausted") return Duration.millis(Math.max(input.resetAt - now, 1_000));
        if (input._tag === "RateLimited") return Duration.millis(Math.max(input.retryAfterMillis, 1_000));
        return duration;
      }),
    ),
  ),
  times: 12,
  while: (error: GitHubError) => error._tag === "TokenBudgetExhausted" || error._tag === "RateLimited",
};

// A README GitHub will not serve for reasons of this repo alone skips the repo. Anything every repo would hit stops
// the run, so a rerun can resume.
const unreadable = (error: GitHubError | BlobStore.BlobStoreFailed) =>
  error._tag === "NotFound" ||
  ((error._tag === "GitHubRequestFailed" || error._tag === "GitHubResponseInvalid") && isPermanent(error));

const notSaved = (error: DbQueryFailed | DbRowInvalid) =>
  error._tag === "DbQueryFailed"
    ? new AnswerNotSaved({
        reason: error.reason,
        sqlState: error.sqlState,
        refused: error.reason === "query" || error.reason === "constraint",
      })
    : new AnswerNotSaved({ reason: error._tag, sqlState: null, refused: true });

const answerBytes = (answered: Answered) =>
  Result.isSuccess(answered.answer) ? JSON.stringify(answered.answer.success).length : 0;

// Splits a group further so no commit carries more than groupBytes of answers.
const byBytes = (group: ReadonlyArray<Answered>): Array<Array<Answered>> => {
  const groups: Array<Array<Answered>> = [];
  let current: Array<Answered> = [];
  let bytes = 0;
  for (const answered of group) {
    const size = answerBytes(answered);
    if (current.length > 0 && bytes + size > groupBytes) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(answered);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

const itemsOf = (stored: StoredRequest, open: ReadonlySet<number>) =>
  Arr.zip(stored.items, stored.request.prompts).flatMap(([item, text], index) =>
    open.has(item.repoId) ? [{ item: { stored: item, text } satisfies Item, index }] : [],
  );

// The answer an item gets when its batch had none that decodes: the error a direct call would have given, so settling
// it counts the same failures enrichment counts.
const unanswered = (raw: Batches.BatchItems[number], model: string): AiError =>
  raw === undefined
    ? new AiRequestFailed({ operation: "generate", model, detail: "batch item missing" })
    : Result.isFailure(raw)
      ? raw.failure
      : new AiOutputInvalid({ operation: "generate", model, detail: "structured output does not match the schema" });

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const transactions = yield* Db.Transactions;
  const github = yield* GitHub.GitHub;
  const blobs = yield* BlobStore.BlobStore;
  const batches = yield* Batches.Batches;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const embeddings = yield* Embeddings.Embeddings;

  const run = Effect.fn("Prefill.run")(function* (options: PrefillOptions) {
    const owner = yield* newId;
    const done = options.progress ?? progress();
    const { outcomes: seen, unresolved, usage, counts, stuck, retried, captures } = done;
    // A repo keeps the first outcome the run gave it, so one a resumed manifest saved is not reported again as done.
    const mark = (ids: Iterable<RepoId>, outcome: Outcome) => {
      for (const id of ids) if (!seen.has(id)) seen.set(id, outcome);
    };
    const projector = yield* RepoKnowledge.projector.pipe(Effect.provideService(Db.Db, db));
    const model = options.adapter === "gateway-batch" ? batches.model : textGeneration.model;
    const source = (answered: Answered): Db.ReceiptSource =>
      (answered.direct ? textGeneration.provider : batches.provider) === "fake" ? "stand-in" : "model";

    const readme = (facts: RepoFacts): Effect.Effect<string | null, GitHubError | BlobStore.BlobStoreFailed> => {
      const oid = facts.readme?.oid;
      if (oid === undefined) return Effect.succeed(null);
      const key = BlobStore.readmeKey(oid);
      return Effect.flatMap(blobs.get(key), (stored) =>
        Option.match(stored, {
          onSome: Effect.succeed,
          onNone: () =>
            github.readme({ owner: facts.owner, name: facts.name, oid }).pipe(
              Effect.retry(budgetRetry),
              Effect.tap((text) => blobs.put(key, text)),
            ),
        }),
      );
    };

    // One CLI call for an item. The CLI has no provider batch, so this is the whole answer on that adapter.
    const askDirectly = ({ stored: item, text }: Item) =>
      Effect.result(
        Summarize.summarizePrompted({ text, input: item.input }).pipe(
          Effect.provideService(TextGeneration.TextGeneration, textGeneration),
        ),
      ).pipe(Effect.map((answer): Answered => ({ item, answer, direct: true })));

    // A batch answer decoded against its prompt, with the tokens the provider reported for it.
    const decode = (
      { stored: item }: Item,
      raw: Batches.BatchItems[number],
      answerModel: string,
    ): Effect.Effect<Result.Result<Summarize.RepoSummary, AiError>> => {
      if (raw === undefined || Result.isFailure(raw)) return Effect.succeed(Result.fail(unanswered(raw, answerModel)));
      const { output, usage: used } = raw.success;
      return Effect.all([
        countTokens(answerModel, "input", used.inputTokens),
        countTokens(answerModel, "output", used.outputTokens),
        Effect.sync(() => usage.push({ repoId: item.repoId, ...used })),
      ]).pipe(
        Effect.andThen(Summarize.answerOf(item.input, output)),
        Effect.map((summary) => Result.succeed<Summarize.RepoSummary>(summary)),
        Effect.catchTags({ SchemaError: () => Effect.succeed(Result.fail(unanswered(raw, answerModel))) }),
      );
    };

    // Commit A for one group. A group the database refuses as a whole is saved one answer at a time, so a bad answer
    // fails only its own repo. A group lost to a reason any group could hit keeps its leases for a later run.
    const capture = (paid: ReadonlyArray<RepoKnowledge.Paid>) =>
      RepoKnowledge.capture(paid).pipe(
        Effect.provideService(Db.Db, db),
        Effect.map((captured) => captured.map((outcome) => Result.succeed<RepoKnowledge.Captured>(outcome))),
        Effect.catch((error) => {
          const failure = notSaved(error);
          return failure.refused && paid.length > 1
            ? Effect.forEach(paid, (one) =>
                RepoKnowledge.capture([one]).pipe(
                  Effect.provideService(Db.Db, db),
                  Effect.map((captured) =>
                    captured[0] === undefined
                      ? Result.fail<AnswerNotSaved>(failure)
                      : Result.succeed<RepoKnowledge.Captured>(captured[0]),
                  ),
                  Effect.catch((alone) => Effect.succeed(Result.fail(notSaved(alone)))),
                ),
              )
            : Effect.succeed(paid.map(() => Result.fail(failure)));
        }),
      );

    // Embeds the summaries a group saved. A failure other than a model mismatch only logs, because the repo stays
    // pending for its embedding and the sweep embeds it with no paid summary.
    const embed = Effect.fn("Prefill.embed")(
      function* (
        saved: ReadonlyArray<{
          readonly item: StoredItem;
          readonly summary: string;
          readonly keywords: ReadonlyArray<string>;
        }>,
      ) {
        if (saved.length === 0) return;
        const vectors = yield* embeddings.embed(
          saved.map(({ item, summary, keywords }) =>
            Summarize.embeddingText(
              { fullName: `${item.owner}/${item.name}`, description: item.description },
              { summary, keywords },
            ),
          ),
        );
        yield* Effect.forEach(
          Arr.zip(saved, vectors),
          ([{ item, summary, keywords }, vector]) =>
            Effect.flatMap(Effect.orDie(decodeEmbedding(vector)), (embedding) =>
              db.repos.saveEmbedding({
                id: item.repoId,
                owner: item.owner,
                name: item.name,
                embedding,
                summary,
                keywords,
                description: item.description,
                readmeOid: item.readmeOid,
              }),
            ),
          { concurrency: embedSaveConcurrency },
        );
      },
      Effect.catchIf(
        (error) => error._tag !== "EmbeddingModelMismatch",
        (error) => Effect.logWarning("Prefill embedding failed, the sweep embeds these repos", { error: error._tag }),
      ),
    );

    // One group: commit A, then every failed item settled while the manifest still holds it, then commit B and the
    // embeddings, so an abort in either never leaves a settled failure to be paid for again.
    const flush = Effect.fn("Prefill.flush")(function* (
      manifest: Db.Manifest,
      answerModel: string,
      group: ReadonlyArray<Answered>,
    ) {
      const answered = group.flatMap((entry) =>
        Result.isSuccess(entry.answer) ? [{ entry, summary: entry.answer.success }] : [],
      );
      const failedCalls = group.flatMap((entry) =>
        Result.isFailure(entry.answer) ? [{ entry, error: entry.answer.failure }] : [],
      );
      const captured = yield* capture(
        answered.map(({ entry, summary }): RepoKnowledge.Paid => {
          const { repoId, readmeOid, inputHash } = entry.item;
          return {
            batchId: manifest.id,
            recipe: manifest.recipe,
            repoId,
            readmeOid,
            inputHash,
            source: source(entry),
            model: entry.direct ? textGeneration.model : answerModel,
            answer: summary,
            lease: manifest.leaseUntil,
          };
        }),
      );
      const results = Arr.zip(answered, captured);
      const failures = [
        ...failedCalls.map(({ entry, error }) => ({ id: entry.item.repoId, error })),
        ...results.flatMap(([{ entry }, outcome]) =>
          Result.isFailure(outcome) ? [{ id: entry.item.repoId, error: outcome.failure }] : [],
        ),
      ].map(({ id, error }) => ({ id, error, settled: settlement(error) }));
      yield* db.repos.settleFailures({
        until: manifest.leaseUntil,
        failures: failures.flatMap(({ id, settled }) =>
          settled === "keep" ? [] : [{ id, counted: settled === "count" }],
        ),
        at: yield* DateTime.now,
        retryDelays: EnrichRetry.retryDelays,
      });
      yield* Effect.forEach(
        failures,
        ({ id, error, settled }) =>
          Effect.logWarning("Prefill item failed", { repoId: id, error: error._tag, settled, detail: error.message }),
        { discard: true },
      );
      const saved = results.flatMap(([{ entry }, outcome]) =>
        Result.isSuccess(outcome) && outcome.success._tag === "Saved"
          ? [{ item: entry.item, summary: outcome.success.summary, keywords: outcome.success.keywords }]
          : [],
      );
      yield* projector.projectSaved(saved.map(({ item }) => item.repoId));
      yield* embed(saved);
      for (const [{ entry }, outcome] of results) {
        if (Result.isSuccess(outcome)) mark([entry.item.repoId], outcome.success._tag === "Saved" ? "saved" : "stale");
      }
      for (const { id, settled } of failures) mark([id], settled === "keep" ? "waiting" : "failed");
    });

    const flushAll = <E>(manifest: Db.Manifest, answerModel: string, answers: Stream.Stream<Answered, E>) =>
      answers.pipe(
        Stream.groupedWithin(groupRows, groupDeadline),
        Stream.flatMap((group) => Stream.fromIterable(byBytes(group))),
        Stream.mapEffect((group) => flush(manifest, answerModel, group)),
        Stream.runDrain,
      );

    // Keeps a manifest's repos leased while the driver waits on its batch. Each renewal moves the manifest's lease and
    // every repo still holding it in one statement, and is never interrupted halfway, so lease always names the lease
    // the repos hold.
    const renewOnce = Effect.fn("Prefill.renewLease")(function* (manifest: Db.Manifest, lease: Ref.Ref<DateTime.Utc>) {
      const until = DateTime.addDuration(yield* DateTime.now, batchLease);
      const current = yield* Ref.get(lease);
      yield* db.knowledge.extendBatch({ manifest: { ...manifest, leaseUntil: current }, until });
      yield* Ref.set(lease, until);
    });
    // A renewal that fails, such as on a lost connection, is tried again at the next tick rather than end the renewals.
    const renewing = (manifest: Db.Manifest, lease: Ref.Ref<DateTime.Utc>) =>
      renewOnce(manifest, lease).pipe(
        Effect.uninterruptible,
        Effect.catch((error) =>
          Effect.logWarning("Prefill lease renewal failed, trying again at the next tick", {
            manifest: manifest.id,
            error: error._tag,
          }),
        ),
        Effect.delay(leaseRenewal),
        Effect.forever,
      );

    // The answers to a manifest's batch, from the batch ID it recorded when there is one, so a resume never depends on
    // the provider still knowing the request's key. A request is sent only when no batch is recorded or the provider
    // has forgotten it. None leaves the manifest open: nothing about the batch is known to be final.
    const obtain = Effect.fn("Prefill.obtain")(function* (manifest: Db.Manifest, stored: StoredRequest, owed: number) {
      const size = stored.items.length;
      const keepOpen = (step: string, error: AiError) =>
        Effect.logWarning("Prefill batch left open for a later run", {
          manifest: manifest.id,
          step,
          error: error._tag,
        }).pipe(Effect.as(Option.none<Batches.Collected>()));
      if (manifest.providerBatchId !== null) {
        const recorded = yield* Effect.result(batches.collect(manifest.providerBatchId, size));
        if (Result.isFailure(recorded)) return yield* keepOpen("collect", recorded.failure);
        if (recorded.success._tag !== "Unknown") return Option.some(recorded.success);
        yield* Effect.logWarning("Prefill provider no longer knows the recorded batch, sending its request again", {
          manifest: manifest.id,
        });
      }
      const submitted = yield* Effect.result(batches.submit(stored.request));
      if (Result.isFailure(submitted)) return yield* keepOpen("submit", submitted.failure);
      if (manifest.providerBatchId !== null && manifest.providerBatchId !== submitted.success) {
        done.repaid += owed;
        yield* Effect.logError("Prefill resend started a new provider batch, so its items are paid for again", {
          manifest: manifest.id,
          items: owed,
        });
      }
      yield* db.knowledge.submittedBatch({ id: manifest.id, providerBatchId: submitted.success });
      const collected = yield* Effect.result(batches.collect(submitted.success, size));
      if (Result.isFailure(collected)) return yield* keepOpen("collect", collected.failure);
      if (collected.success._tag === "Unknown") {
        return yield* keepOpen(
          "collect",
          new AiRequestFailed({ operation: "generate", model: stored.request.model, detail: "unknown batch" }),
        );
      }
      return Option.some(collected.success);
    });

    // A second batch for the items a first answered badly, under a key of its own. The items' leases move to it in the
    // transaction that writes it, so a crash leaves each item owed by exactly one manifest, and its own bad answers
    // are final.
    const fallback = Effect.fn("Prefill.fallback")(function* (
      parent: Db.Manifest,
      stored: StoredRequest,
      items: ReadonlyArray<Item>,
    ) {
      const request: Batches.BatchRequest = { ...stored.request, prompts: items.map(({ text }) => text), attempt: 2 };
      const requestKey = yield* Batches.requestKey(request);
      const later = DateTime.addDuration(yield* DateTime.now, batchLease);
      const until = DateTime.isGreaterThan(later, parent.leaseUntil)
        ? later
        : DateTime.addDuration(parent.leaseUntil, Duration.millis(1));
      const draft: Db.NewManifest = {
        id: BatchId.make(yield* newId),
        adapter: parent.adapter,
        model: request.model,
        recipe: parent.recipe,
        requestKey,
        requestObject: requestObjectKey(requestKey),
        repoIds: items.map(({ stored: item }) => item.repoId),
        inputHashes: items.map(({ stored: item }) => item.inputHash),
        leaseUntil: until,
        retryOf: parent.id,
      };
      const written = yield* transactions.withTransaction(
        Effect.gen(function* () {
          const id = yield* db.knowledge.prepareBatch(draft);
          if (Option.isNone(id)) return Option.none();
          const moved = yield* db.knowledge.moveLease({ ids: draft.repoIds, from: parent.leaseUntil, to: until });
          return Option.some({ id: id.value, moved });
        }),
      );
      if (Option.isNone(written)) {
        mark(draft.repoIds, "waiting");
        return;
      }
      const manifest: Db.Manifest = { ...draft, id: written.value.id, providerBatchId: null, state: "prepared" };
      counts.fallbacks++;
      retried.push(...written.value.moved);
      const childStored: StoredRequest = { request, items: items.map(({ stored: item }) => item) };
      yield* blobs.put(manifest.requestObject, yield* Effect.orDie(encodeStored(childStored)));
      yield* settle(manifest, childStored, new Set(written.value.moved), false);
    });

    // Every item of the manifest that still holds its lease gets an answer, in groups, and the manifest closes once
    // no repo holds it. Items the batch answered badly go to one fallback batch, and a fallback's own are final.
    const settle: (
      manifest: Db.Manifest,
      stored: StoredRequest,
      open: ReadonlySet<number>,
      resumed: boolean,
    ) => Effect.Effect<void, PrefillAbort> = Effect.fn("Prefill.settle")(function* (manifest, stored, open, resumed) {
      const pending = itemsOf(stored, open);
      const answeredFrom = yield* Clock.currentTimeMillis;
      const close = Effect.fn("Prefill.close")(function* (closing: Db.Manifest) {
        if (pending.length > 0) {
          captures.push({ items: pending.length, seconds: ((yield* Clock.currentTimeMillis) - answeredFrom) / 1000 });
        }
        if (yield* db.knowledge.closeBatch(closing)) counts.closed++;
      });
      if (pending.length === 0) return yield* close(manifest);
      if (manifest.adapter === "claude-code") {
        if (resumed) done.repaid += pending.length;
        yield* db.knowledge.submittedBatch({ id: manifest.id, providerBatchId: null });
        yield* flushAll(
          manifest,
          textGeneration.model,
          Stream.fromIterable(pending).pipe(
            Stream.mapEffect(({ item }) => askDirectly(item), { concurrency: directConcurrency, unordered: true }),
          ),
        );
        return yield* close(manifest);
      }
      const lease = yield* Ref.make(manifest.leaseUntil);
      const renewal = yield* Effect.forkChild(renewing(manifest, lease));
      const collected = yield* obtain(manifest, stored, pending.length).pipe(
        Effect.timeoutOption(collectDeadline),
        Effect.map(Option.flatten),
        Effect.ensuring(Fiber.interrupt(renewal)),
      );
      const current: Db.Manifest = { ...manifest, leaseUntil: yield* Ref.get(lease) };
      if (Option.isNone(collected) || collected.value._tag === "Unknown") {
        mark(
          pending.map(({ item }) => item.stored.repoId),
          "waiting",
        );
        return;
      }
      const answerModel = stored.request.model;
      const batch = collected.value;
      const results = yield* Effect.forEach(pending, ({ item, index }) =>
        (batch._tag === "Answered"
          ? decode(item, batch.items[index], answerModel)
          : Effect.succeed(
              Result.fail<AiError>(
                new AiRequestFailed({ operation: "generate", model: answerModel, detail: batch.detail }),
              ),
            )
        ).pipe(Effect.map((answer) => ({ item, answer }))),
      );
      const final = stored.request.attempt !== undefined;
      const settled = results.flatMap(
        ({ item, answer }): Array<Answered> =>
          Result.isSuccess(answer) || final ? [{ item: item.stored, answer, direct: false }] : [],
      );
      yield* flushAll(current, answerModel, Stream.fromIterable(settled));
      const again = final ? [] : results.flatMap(({ item, answer }) => (Result.isFailure(answer) ? [item] : []));
      if (again.length > 0) yield* fallback(current, stored, again);
      return yield* close(current);
    });

    // A manifest a run left open. Its stored request must still hash to its key, so a resend can only ever find the
    // batch it already started. A manifest that was never sent and has no request is deleted and its leases given
    // back. Any other unreadable request is kept, with its leases, until someone restores it.
    const resume = Effect.fn("Prefill.resume")(function* (manifest: Db.Manifest) {
      const object = yield* blobs.get(manifest.requestObject);
      const stored = Option.flatMap(object, decodeStored);
      const key = Option.isSome(stored) ? yield* Batches.requestKey(stored.value.request) : null;
      if (Option.isNone(stored) || key !== manifest.requestKey) {
        const unsent = Option.isNone(object) && manifest.providerBatchId === null && manifest.state === "prepared";
        if (unsent && (yield* db.knowledge.dropBatch({ manifest, owner }))) {
          counts.dropped++;
          return;
        }
        stuck.push(manifest.id);
        mark(manifest.repoIds, "waiting");
        yield* Effect.logError("Prefill manifest has no readable request, so it is kept until the object is restored", {
          manifest: manifest.id,
          missing: Option.isNone(object),
          sent: manifest.providerBatchId !== null,
        });
        return;
      }
      const until = DateTime.addDuration(yield* DateTime.now, batchLease);
      const open = yield* db.knowledge.extendBatch({ manifest, until });
      counts.resumed++;
      yield* settle({ ...manifest, leaseUntil: until }, stored.value, new Set(open), true);
    });

    // GitHub facts for a chunk: by node ID where Stargrep knows it, and by name otherwise or when the node is gone or
    // private.
    const resolve = Effect.fn("Prefill.resolve")(function* (refs: ReadonlyArray<GitHub.ArchiveRef>) {
      const known = new Map((yield* db.repos.getMany(refs.map((ref) => ref.id))).map((row) => [row.id, row.nodeId]));
      const nodeIds = refs.flatMap((ref) => {
        const nodeId = known.get(ref.id);
        return nodeId === undefined || nodeId === null ? [] : [nodeId];
      });
      const byNode = nodeIds.length === 0 ? [] : yield* github.repoFacts(nodeIds).pipe(Effect.retry(budgetRetry));
      const found = new Set<number>(byNode.map((facts) => facts.id));
      const byName = yield* github
        .resolveRepos(refs.filter((ref) => !found.has(ref.id)))
        .pipe(Effect.retry(budgetRetry));
      unresolved.push(...byName.unresolved);
      mark(
        byName.unresolved.map((entry) => entry.id),
        "unresolved",
      );
      const asked = new Set<number>(refs.map((ref) => ref.id));
      return [...byNode.filter((facts) => asked.has(facts.id)), ...byName.facts];
    });

    // Saves the chunk's facts and takes the lease of every repo due, then writes the manifest, in one transaction, so a
    // crash leaves either both or neither. A key an open manifest already holds rolls both back.
    const prepare = Effect.fn("Prefill.prepare")(function* (
      readable: ReadonlyArray<{ readonly facts: RepoFacts; readonly readme: string | null }>,
    ) {
      const now = yield* DateTime.now;
      const until = DateTime.addDuration(now, batchLease);
      const byId = new Map(readable.map((entry) => [entry.facts.id, entry]));
      const prepared = yield* transactions
        .withTransaction(
          Effect.gen(function* () {
            const leases = yield* db.repos.saveFactsAndLease({
              repos: readable.map(({ facts }) => ({
                id: facts.id,
                nodeId: facts.nodeId,
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
                readmeOid: facts.readme?.oid ?? null,
                ownerType: facts.ownerType,
                ownerAvatarUrl: facts.ownerAvatarUrl,
                stars: facts.stars,
                forks: facts.forks,
              })),
              now,
              until,
            });
            const leased = Arr.sort(
              leases.filter((lease) => lease.leased),
              Order.mapInput(Order.Number, (lease: Db.FactsLease) => lease.id),
            );
            const held = leases.filter((lease) => !lease.leased).map((lease) => lease.id);
            if (leased.length === 0) return { held, written: Option.none() };
            const prompted = leased.flatMap((lease) => {
              const entry = byId.get(lease.id);
              if (entry === undefined) return [];
              const { facts, readme: text } = entry;
              const prompt = Summarize.promptOf({
                fullName: `${facts.owner}/${facts.name}`,
                description: facts.description,
                topics: facts.topics,
                language: facts.language,
                readme: text,
              });
              const item: StoredItem = {
                repoId: lease.id,
                inputHash: lease.inputHash,
                readmeOid: facts.readme?.oid ?? null,
                owner: facts.owner,
                name: facts.name,
                description: facts.description,
                input: prompt.input,
              };
              return [{ prompt, item }];
            });
            const request = Summarize.batchRequest(
              model,
              prompted.map(({ prompt }) => prompt),
            );
            const requestKey = yield* Batches.requestKey(request);
            const draft: Db.NewManifest = {
              id: BatchId.make(yield* newId),
              adapter: options.adapter,
              model,
              recipe: summaryRecipe,
              requestKey,
              requestObject: requestObjectKey(requestKey),
              repoIds: leased.map((lease) => lease.id),
              inputHashes: leased.map((lease) => lease.inputHash),
              leaseUntil: until,
              retryOf: null,
            };
            const id = yield* db.knowledge.prepareBatch(draft);
            if (Option.isNone(id)) return yield* new KeyHeld({ repos: draft.repoIds.length });
            const manifest: Db.Manifest = { ...draft, id: id.value, providerBatchId: null, state: "prepared" };
            return {
              held,
              written: Option.some({ manifest, stored: { request, items: prompted.map(({ item }) => item) } }),
            };
          }),
        )
        .pipe(
          Effect.catchTags({
            KeyHeld: ({ repos }) =>
              Effect.logError("Prefill chunk's request key is held by an open manifest, so it waits for that one", {
                repos,
              }).pipe(Effect.as({ held: readable.map(({ facts }) => facts.id), written: Option.none() })),
          }),
        );
      mark(prepared.held, "held");
      return prepared.written;
    });

    const chunk = Effect.fn("Prefill.chunk")(function* (refs: ReadonlyArray<GitHub.ArchiveRef>) {
      const done = new Set<number>(yield* db.repos.summarized(refs.map((ref) => ref.id)));
      mark(
        refs.filter((ref) => done.has(ref.id)).map((ref) => ref.id),
        "done",
      );
      const todo = refs.filter((ref) => !done.has(ref.id));
      if (todo.length === 0) return;
      const facts = yield* resolve(todo);
      const read = yield* Effect.forEach(
        facts,
        (entry) =>
          readme(entry).pipe(
            Effect.map((text) => Option.some({ facts: entry, readme: text })),
            Effect.catchIf(unreadable, () =>
              Effect.sync(() => {
                mark([entry.id], "unreadable");
                return Option.none();
              }),
            ),
          ),
        { concurrency: readmeConcurrency },
      );
      const prepared = yield* prepare(read.flatMap((entry) => Option.toArray(entry)));
      if (Option.isNone(prepared)) return;
      const { manifest, stored } = prepared.value;
      counts.created++;
      yield* blobs.put(manifest.requestObject, yield* Effect.orDie(encodeStored(stored)));
      yield* settle(manifest, stored, new Set(manifest.repoIds), false);
    });

    const work = Effect.gen(function* () {
      yield* Effect.forEach(yield* db.knowledge.openBatches, resume, {
        concurrency: options.concurrency,
        discard: true,
      });
      const sorted = Arr.sort(
        Arr.dedupeWith(options.refs, (a, b) => a.id === b.id),
        Order.mapInput(Order.Number, (ref: GitHub.ArchiveRef) => ref.id),
      );
      yield* Effect.forEach(Arr.chunksOf(sorted, options.chunk), chunk, {
        concurrency: options.concurrency,
        discard: true,
      });
    });

    // The driver holds the prefill for the whole run, so no other driver resumes, drops, or pays for its manifests.
    // A heartbeat that finds the claim taken stops the run.
    const now = yield* DateTime.now;
    const claimed = yield* db.knowledge.claimPrefill({
      owner,
      now,
      stale: DateTime.subtractDuration(now, ownerStale),
    });
    if (!claimed) return yield* new PrefillBusy();
    // A heartbeat that cannot reach the database is tried again at the next tick. Only another driver's claim stops it.
    const heartbeat = Effect.gen(function* () {
      const held = yield* db.knowledge.heartbeatPrefill({ owner, now: yield* DateTime.now }).pipe(
        Effect.catchTags({
          DbQueryFailed: (error) =>
            Effect.logWarning("Prefill heartbeat failed, trying again", { error: error.reason }).pipe(Effect.as(true)),
          DbRowInvalid: () => Effect.succeed(true),
        }),
      );
      if (!held) return yield* new PrefillOwnershipLost();
    }).pipe(Effect.delay(ownerHeartbeat), Effect.forever);
    yield* Effect.raceFirst(work, heartbeat).pipe(Effect.ensuring(Effect.ignore(db.knowledge.releasePrefill(owner))));
    return reportOf(done);
  });

  return Prefill.of({ run });
});

// An open manifest already holds the key a chunk's request hashes to, so the chunk's lease rolls back.
class KeyHeld extends Schema.TaggedError<KeyHeld, { readonly brand: unique symbol }>()("KeyHeld", {
  repos: Schema.Int,
}) {}

export const layer = Layer.effect(Prefill, make);
