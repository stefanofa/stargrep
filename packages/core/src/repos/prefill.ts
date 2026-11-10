import * as Batches from "@stargrep/ai/batches";
import * as Embeddings from "@stargrep/ai/embeddings";
import type { AiError } from "@stargrep/ai/errors";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RepoKnowledge from "../knowledge/repo-knowledge.ts";
import * as BlobStore from "./blob-store.ts";
import { AnswerNotSaved, settlement } from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";

// The lease a prefill batch holds, longer than the Gateway's 24-hour batch window, so no sweep or consumer finds one of
// its repos due while the batch is open. Resume moves it forward.
export const batchLease = Duration.hours(26);
// Capture flushes a group when it reaches any of these, so one commit A and one commit B cover each group.
export const groupRows = 64;
export const groupBytes = 1_000_000;
export const groupDeadline = Duration.seconds(2);
// Prompts asked directly at once, for items a batch did not answer, and READMEs read at once per chunk.
const directConcurrency = 4;
const readmeConcurrency = 4;
// Embedding saves are one statement per repo, so a group sends a few at once rather than wait out each round trip.
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
  };
  // Tokens each batch answer used, as the provider reported them. Direct calls count in stargrep_ai_tokens.
  readonly usage: ReadonlyArray<ItemUsage>;
  // Repos answered by a direct call because the batch gave no answer that decodes.
  readonly direct: ReadonlyArray<RepoId>;
  // Items a resumed send paid for again, because the provider started a new batch instead of finding the one the
  // manifest names. The idempotency key should make this zero.
  readonly repaid: number;
  readonly captures: ReadonlyArray<CaptureTime>;
}

export interface PrefillOptions {
  readonly refs: ReadonlyArray<GitHub.ArchiveRef>;
  readonly adapter: Db.BatchAdapter;
  readonly chunk: number;
  readonly concurrency: number;
}

export type PrefillAbort =
  | DbQueryFailed
  | DbRowInvalid
  | GitHubError
  | BlobStore.BlobStoreFailed
  | EmbeddingModelMismatch;

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

const newBatchId = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.map(BatchId.make),
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

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const transactions = yield* Db.Transactions;
  const github = yield* GitHub.GitHub;
  const blobs = yield* BlobStore.BlobStore;
  const batches = yield* Batches.Batches;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const embeddings = yield* Embeddings.Embeddings;

  const run = Effect.fn("Prefill.run")(function* (options: PrefillOptions) {
    const seen = new Map<RepoId, Outcome>();
    const unresolved: Array<GitHub.Unresolved> = [];
    const usage: Array<ItemUsage> = [];
    const manifests = { resumed: 0, dropped: 0, created: 0, closed: 0 };
    const direct: Array<RepoId> = [];
    const captures: Array<CaptureTime> = [];
    let repaid = 0;
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

    // A batch answer decoded against its prompt, or one direct call when the batch gave none that decodes.
    const answer = ({ stored: item, text }: Item, raw: Batches.BatchItems[number]) => {
      const directly = Effect.result(
        Summarize.summarizePrompted({ text, input: item.input }).pipe(
          Effect.provideService(TextGeneration.TextGeneration, textGeneration),
        ),
      ).pipe(
        Effect.tap(() => Effect.sync(() => direct.push(item.repoId))),
        Effect.map((result): Answered => ({ item, answer: result, direct: true })),
      );
      if (raw === undefined || Result.isFailure(raw)) return directly;
      const { output, usage: used } = raw.success;
      return Effect.all([
        countTokens(model, "input", used.inputTokens),
        countTokens(model, "output", used.outputTokens),
        Effect.sync(() => usage.push({ repoId: item.repoId, ...used })),
      ]).pipe(
        Effect.andThen(Summarize.answerOf(item.input, output)),
        Effect.map((summary): Answered => ({ item, answer: Result.succeed(summary), direct: false })),
        Effect.catchTags({ SchemaError: () => directly }),
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

    // One group: commit A, commit B, embeddings, then every failed item settled while the manifest still holds it.
    const flush = Effect.fn("Prefill.flush")(function* (manifest: Db.Manifest, group: ReadonlyArray<Answered>) {
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
            repoId,
            readmeOid,
            inputHash,
            source: source(entry),
            model: entry.direct ? textGeneration.model : model,
            answer: summary,
            lease: manifest.leaseUntil,
          };
        }),
      );
      const results = Arr.zip(answered, captured);
      const saved = results.flatMap(([{ entry }, outcome]) =>
        Result.isSuccess(outcome) && outcome.success._tag === "Saved"
          ? [{ item: entry.item, summary: outcome.success.summary, keywords: outcome.success.keywords }]
          : [],
      );
      yield* projector.projectSaved(saved.map(({ item }) => item.repoId));
      yield* embed(saved);
      const failures = [
        ...failedCalls.map(({ entry, error }) => ({ id: entry.item.repoId, error })),
        ...results.flatMap(([{ entry }, outcome]) =>
          Result.isFailure(outcome) ? [{ id: entry.item.repoId, error: outcome.failure }] : [],
        ),
      ].map(({ id, error }) => ({ id, error, settled: settlement(error) }));
      yield* Effect.forEach(
        failures,
        ({ id, error, settled }) =>
          Effect.logWarning("Prefill item failed", {
            repoId: id,
            error: error._tag,
            settled,
            detail: error.message,
          }),
        { discard: true },
      );
      yield* db.repos.settleFailures({
        until: manifest.leaseUntil,
        failures: failures.flatMap(({ id, settled }) =>
          settled === "keep" ? [] : [{ id, counted: settled === "count" }],
        ),
        at: yield* DateTime.now,
        retryDelays: EnrichRetry.retryDelays,
      });
      for (const [{ entry }, outcome] of results) {
        if (Result.isSuccess(outcome)) mark([entry.item.repoId], outcome.success._tag === "Saved" ? "saved" : "stale");
      }
      for (const { id, settled } of failures) mark([id], settled === "keep" ? "waiting" : "failed");
    });

    // Sends the stored request, or finds the batch an earlier send started, since the key is the same. None leaves the
    // manifest open for a later run: the provider could not be reached, and nothing about the batch is final.
    const send = Effect.fn("Prefill.send")(function* (manifest: Db.Manifest, stored: StoredRequest, owed: number) {
      if (manifest.adapter === "claude-code") {
        yield* db.knowledge.submittedBatch({ id: manifest.id, providerBatchId: null });
        return Option.some<Batches.BatchItems>([]);
      }
      const submitted = yield* Effect.result(batches.submit(stored.request));
      if (Result.isFailure(submitted)) {
        yield* Effect.logWarning("Prefill batch not sent, a later run resumes it", {
          manifest: manifest.id,
          error: submitted.failure._tag,
        });
        return Option.none();
      }
      if (manifest.providerBatchId !== null && manifest.providerBatchId !== submitted.success) {
        repaid += owed;
        yield* Effect.logError("Prefill resume started a new provider batch instead of finding its own", {
          manifest: manifest.id,
          items: owed,
        });
      }
      yield* db.knowledge.submittedBatch({ id: manifest.id, providerBatchId: submitted.success });
      const collected = yield* Effect.result(batches.collect(submitted.success, stored.items.length));
      if (Result.isSuccess(collected)) return Option.some(collected.success);
      // A provider that failed the batch itself answers nothing more, so its items are asked directly, as
      // TextGeneration.generateBatch does. Anything else may pass, so the batch stays open.
      if (collected.failure._tag === "AiRequestFailed") return Option.some<Batches.BatchItems>([]);
      yield* Effect.logWarning("Prefill batch not collected, a later run resumes it", {
        manifest: manifest.id,
        error: collected.failure._tag,
      });
      return Option.none();
    });

    // Every item of the manifest that still holds its lease gets an answer, in groups, and the manifest closes once
    // no repo holds it.
    const settle = Effect.fn("Prefill.settle")(function* (
      manifest: Db.Manifest,
      stored: StoredRequest,
      open: ReadonlySet<number>,
    ) {
      const pending = Arr.zip(stored.items, stored.request.prompts).flatMap(([item, text], index) =>
        open.has(item.repoId) ? [{ item: { stored: item, text }, index }] : [],
      );
      if (pending.length > 0) {
        const raw = yield* send(manifest, stored, pending.length);
        if (Option.isNone(raw)) {
          mark(
            pending.map(({ item }) => item.stored.repoId),
            "waiting",
          );
          return;
        }
        const answeredFrom = yield* Clock.currentTimeMillis;
        yield* Stream.fromIterable(pending).pipe(
          Stream.mapEffect(({ item, index }) => answer(item, raw.value[index]), {
            concurrency: directConcurrency,
            unordered: true,
          }),
          Stream.groupedWithin(groupRows, groupDeadline),
          Stream.flatMap((group) => Stream.fromIterable(byBytes(group))),
          Stream.mapEffect((group) => flush(manifest, group)),
          Stream.runDrain,
        );
        captures.push({ items: pending.length, seconds: ((yield* Clock.currentTimeMillis) - answeredFrom) / 1000 });
      }
      if (yield* db.knowledge.closeBatch(manifest)) manifests.closed++;
    });

    // A manifest a run left open: its stored request is sent again byte for byte, so the provider returns the batch it
    // already paid for, and only the items whose repos still hold the lease are captured.
    const resume = Effect.fn("Prefill.resume")(function* (manifest: Db.Manifest) {
      const stored = Option.flatMap(yield* blobs.get(manifest.requestObject), decodeStored);
      const key = Option.isSome(stored) ? yield* Batches.requestKey(stored.value.request) : null;
      if (Option.isNone(stored) || key !== manifest.requestKey) {
        yield* Effect.logWarning("Prefill manifest has no readable request, its leases are given back", {
          manifest: manifest.id,
          sent: manifest.providerBatchId !== null,
        });
        yield* db.knowledge.dropBatch(manifest);
        manifests.dropped++;
        return;
      }
      const until = DateTime.addDuration(yield* DateTime.now, batchLease);
      const open = yield* db.knowledge.extendBatch({ manifest, until });
      manifests.resumed++;
      yield* settle({ ...manifest, leaseUntil: until }, stored.value, new Set(open));
    });

    // GitHub facts for a chunk: by node ID where Stargrep knows it, and by name otherwise or when the node is gone.
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
    // crash leaves either both or neither.
    const prepare = Effect.fn("Prefill.prepare")(function* (
      readable: ReadonlyArray<{ readonly facts: RepoFacts; readonly readme: string | null }>,
    ) {
      const now = yield* DateTime.now;
      const until = DateTime.addDuration(now, batchLease);
      const byId = new Map(readable.map((entry) => [entry.facts.id, entry]));
      return yield* transactions.withTransaction(
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
          mark(
            leases.filter((lease) => !lease.leased).map((lease) => lease.id),
            "held",
          );
          if (leased.length === 0) return Option.none();
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
          const manifest: Db.Manifest = {
            id: yield* newBatchId,
            adapter: options.adapter,
            model,
            recipe: summaryRecipe,
            requestKey,
            requestObject: requestObjectKey(requestKey),
            providerBatchId: null,
            repoIds: leased.map((lease) => lease.id),
            inputHashes: leased.map((lease) => lease.inputHash),
            state: "prepared",
            leaseUntil: until,
          };
          yield* db.knowledge.prepareBatch(manifest);
          return Option.some({ manifest, stored: { request, items: prompted.map(({ item }) => item) } });
        }),
      );
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
      manifests.created++;
      yield* blobs.put(manifest.requestObject, yield* Effect.orDie(encodeStored(stored)));
      yield* settle(manifest, stored, new Set(manifest.repoIds));
    });

    yield* Effect.forEach(yield* db.knowledge.openBatches, resume, { concurrency: options.concurrency, discard: true });
    const sorted = Arr.sort(
      Arr.dedupeWith(options.refs, (a, b) => a.id === b.id),
      Order.mapInput(Order.Number, (ref: GitHub.ArchiveRef) => ref.id),
    );
    yield* Effect.forEach(Arr.chunksOf(sorted, options.chunk), chunk, {
      concurrency: options.concurrency,
      discard: true,
    });
    return { outcomes: seen, unresolved, manifests, usage, direct, repaid, captures } satisfies PrefillReport;
  });

  return Prefill.of({ run });
});

export const layer = Layer.effect(Prefill, make);
