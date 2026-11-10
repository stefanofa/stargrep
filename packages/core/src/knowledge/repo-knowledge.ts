import { summaryRecipe } from "@stargrep/ai/models";
import type { RepoSummary } from "@stargrep/ai/summarize";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { ObjectId, RepoId } from "@stargrep/github/schemas";
import { rules as replayRules } from "@stargrep/knowledge/decisions";
import { type BatchId, type InputHash, ReceiptId, type Revision } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { type LabelEntry, lookupKeys, project, type Rules } from "@stargrep/knowledge/projection";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// Repos one projection transaction locks and writes.
export const groupSize = 64;
// Groups one sweep projects at most, so one run stays well inside the cron's time budget.
export const groupsPerSweep = 50;

const labelIndex = (labels: ReadonlyArray<Db.Label>) => {
  const index = new Map<LabelKey, Array<LabelEntry>>();
  for (const label of labels) {
    index.set(label.key, [...(index.get(label.key) ?? []), { subject: label.subjectId, isDefault: label.isDefault }]);
  }
  return index;
};

type RulesAt = (revision: Revision) => Effect.Effect<Rules, DbQueryFailed | DbRowInvalid>;

// Projects one group under the shared lock. A repo whose claims need a subject minted is left stale and returned with
// its mints, because its atoms would be incomplete.
const projectGroup = Effect.fn("RepoKnowledge.projectGroup")(function* (ids: ReadonlyArray<RepoId>, rulesAt: RulesAt) {
  const db = yield* Db.Db;
  const { projected, carry } = yield* db.knowledge.project(ids, (locked, revision) =>
    Effect.gen(function* () {
      const rules = yield* rulesAt(revision);
      const labels = labelIndex(yield* db.knowledge.labels(locked.flatMap((repo) => lookupKeys(repo.claims, repo))));
      const projections = locked.map((repo) => ({
        repo,
        projection: project({ repo, facts: repo, claims: repo.claims, labels, rules }),
      }));
      const incomplete = projections.filter(({ projection }) => projection.mints.length > 0);
      return {
        write: projections
          .filter(({ projection }) => projection.mints.length === 0)
          .map(({ repo, projection }) => ({
            repoId: repo.id,
            receiptId: repo.receiptId,
            atoms: projection.atoms,
            unresolvedKeys: projection.unresolvedKeys,
            verdicts: projection.verdicts,
          })),
        carry: {
          waiting: incomplete.map(({ repo }) => repo.id),
          mints: incomplete.flatMap(({ repo, projection }): Array<Db.MintClaim> => {
            const receiptId = repo.receiptId;
            return receiptId === null ? [] : projection.mints.map((mint) => ({ ...mint, receiptId }));
          }),
        },
      };
    }),
  );
  return { projected, ...carry };
});

// The rules a projection reads must be those of the revision it holds the shared lock at, since no decision commits
// while it holds it. They replay the merges, splits, corrections, and undos alone, unchecked, because curation checked
// each decision when it wrote it, so a large seed or floor batch costs projection nothing. They are cached by the head
// they were read at, under the same lock, so a decision that lands mid-run moves the head and the next group reads them
// again.
const rulesCache = (db: Db.Db["Service"]): RulesAt => {
  let cached: { readonly at: Revision; readonly rules: Rules } | null = null;
  return (revision) =>
    cached !== null && cached.at === revision
      ? Effect.succeed(cached.rules)
      : Effect.map(db.knowledge.rules, (decisions) => {
          const rules = replayRules(decisions);
          cached = { at: revision, rules };
          return rules;
        });
};

// Projection for one run, such as a sweep or an enrichment, which holds one rules cache across every group it projects.
export interface Projector {
  // Projects these repos from their receipts and GitHub facts, with no model call. Repos that need new subjects get
  // them minted under the exclusive lock, which marks stale every repo that looked their keys up, and are projected
  // again.
  readonly project: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<{ readonly projected: number; readonly minted: number }, DbQueryFailed | DbRowInvalid>;
  // Commit B for repos whose answers were just saved. It never calls a model, so when it fails the summaries stay saved
  // and the projection sweep projects the repos from their receipts later. Returns whether it committed.
  readonly projectSaved: (ids: ReadonlyArray<RepoId>) => Effect.Effect<boolean>;
}

export const projector: Effect.Effect<Projector, never, Db.Db> = Effect.gen(function* () {
  const db = yield* Db.Db;
  const rulesAt = rulesCache(db);
  const projectWith = Effect.fn("RepoKnowledge.projectRepos")(
    function* (ids: ReadonlyArray<RepoId>) {
      const first = yield* projectGroup(ids, rulesAt);
      if (first.waiting.length === 0) return { projected: first.projected, minted: 0 };
      const { minted } = yield* db.knowledge.mint(first.mints);
      const second = yield* projectGroup(first.waiting, rulesAt);
      return { projected: first.projected + second.projected, minted: minted.length };
    },
    Effect.provideService(Db.Db, db),
  );
  const projectSaved = Effect.fn("RepoKnowledge.projectSaved")(function* (ids: ReadonlyArray<RepoId>) {
    if (ids.length === 0) return true;
    return yield* projectWith(ids).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Projection after capture failed, the sweep projects these repos later", {
          repos: ids.length,
          error: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );
  });
  return { project: projectWith, projectSaved };
});

export const projectRepos = (ids: ReadonlyArray<RepoId>) =>
  Effect.flatMap(projector, (projection) => projection.project(ids));

export const projectSaved = (ids: ReadonlyArray<RepoId>) =>
  Effect.flatMap(projector, (projection) => projection.projectSaved(ids));

const lostRace = (error: DbQueryFailed | DbRowInvalid) => error._tag === "DbQueryFailed" && error.reason === "conflict";

// The projection sweep: up to groupsPerSweep groups of stale repos, lowest ID first. A group that loses a deadlock or a
// serialization race leaves its rows stale and counts as a group, and the run goes on, so the next group retries them.
// A group can commit a first pass and its mints before its second pass loses, so the run's counts are a lower bound.
export const reproject = Effect.fn("RepoKnowledge.reproject")(function* (
  options: { readonly groupSize: number; readonly groups: number } = { groupSize, groups: groupsPerSweep },
) {
  const db = yield* Db.Db;
  const projection = yield* projector;
  let projected = 0;
  let minted = 0;
  let conflicts = 0;
  for (let group = 0; group < options.groups; group++) {
    const ids = yield* db.knowledge.stale(options.groupSize);
    if (ids.length === 0) break;
    const result = yield* projection.project(ids).pipe(Effect.catchIf(lostRace, () => Effect.succeed(null)));
    if (result === null) {
      conflicts++;
      continue;
    }
    projected += result.projected;
    minted += result.minted;
    if (ids.length < options.groupSize) break;
  }
  return { projected, minted, conflicts };
});

// A summary answer for one repo, with the README and the prompt inputs it describes, and the enrichment lease its
// attempt holds, if any. Capture clears only that lease. A prefill answer names the manifest of the batch it came from.
export interface Paid {
  readonly batchId?: BatchId;
  readonly repoId: RepoId;
  readonly readmeOid: ObjectId | null;
  readonly inputHash: InputHash;
  readonly source: Db.ReceiptSource;
  readonly model: string;
  readonly answer: RepoSummary;
  readonly lease: DateTime.Utc | null;
}

// Saved: the repo shows the receipt's summary, which a retried answer shares with the answer committed first. Stale:
// the repo's README or inputs moved on, or it is gone, so the answer is kept only as history. NotFound: the repo has no
// row, so nothing is kept.
export type Captured = Data.TaggedEnum<{
  Saved: {
    readonly repoId: RepoId;
    readonly receiptId: ReceiptId;
    readonly summary: string;
    readonly keywords: ReadonlyArray<string>;
  };
  Stale: { readonly repoId: RepoId };
  NotFound: { readonly repoId: RepoId };
}>;
export const Captured = Data.taggedEnum<Captured>();

const newReceiptId = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.map(ReceiptId.make),
  Effect.provide(SecureRandom.layerWebCrypto),
);

// Commit A for answers to distinct repos: each answer becomes a receipt, and every repo still at the README and inputs
// its answer describes shows the answer's summary. It touches no vocabulary and writes no facet, so nothing in
// projection can roll back an answer that was paid for.
export const capture = Effect.fn("RepoKnowledge.capture")(function* (answers: ReadonlyArray<Paid>) {
  const db = yield* Db.Db;
  const captured = yield* db.knowledge.capture(
    yield* Effect.forEach(answers, (paid) =>
      Effect.map(
        newReceiptId,
        (receiptId): Db.Answer => ({
          receiptId,
          repoId: paid.repoId,
          source: paid.source,
          inputHash: paid.inputHash,
          readmeOid: paid.readmeOid,
          recipe: summaryRecipe,
          model: paid.model,
          batchId: paid.batchId ?? null,
          summary: paid.answer.summary,
          keywords: paid.answer.keywords,
          claims: paid.answer.facets.claims,
          lanes: paid.answer.facets.lanes,
          dropped: paid.answer.facets.dropped,
          rawKey: null,
          lease: paid.lease,
        }),
      ),
    ),
  );
  const byRepo = new Map<number, Db.Captured>(captured.map((row) => [row.repoId, row]));
  return answers.map(({ repoId }): Captured => {
    const row = byRepo.get(repoId);
    if (row === undefined) return Captured.NotFound({ repoId });
    return row.saved
      ? Captured.Saved({ repoId, receiptId: row.receiptId, summary: row.summary, keywords: row.keywords })
      : Captured.Stale({ repoId });
  });
});

// Both commits for one group of answers, as a caller that holds the group whole saves it.
export const accept = Effect.fn("RepoKnowledge.accept")(function* (answers: ReadonlyArray<Paid>) {
  const captured = yield* capture(answers);
  const projected = yield* projectSaved(
    captured.flatMap((outcome) => (outcome._tag === "Saved" ? [outcome.repoId] : [])),
  );
  return { captured, projected };
});

// The nightly count behind listing: every public subject's repo_count, from the same rows filters and chips read.
export const count = Effect.fn("RepoKnowledge.count")(function* () {
  const db = yield* Db.Db;
  return { changed: yield* db.knowledge.count };
});

// The nightly count of closed values, which lookups read.
export const countAtoms = Effect.fn("RepoKnowledge.countAtoms")(function* () {
  const db = yield* Db.Db;
  return { changed: yield* db.knowledge.countAtoms };
});
