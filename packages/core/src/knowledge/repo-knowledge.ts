import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { RepoId } from "@stargrep/github/schemas";
import { fold, type KnowledgeState } from "@stargrep/knowledge/decisions";
import type { Revision } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { type LabelEntry, lookupKeys, project } from "@stargrep/knowledge/projection";
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

type RulesAt = (revision: Revision) => Effect.Effect<KnowledgeState, DbQueryFailed | DbRowInvalid>;

// Projects one group under the shared lock. A repo whose claims need a subject minted is left stale and returned with
// its mints, because its atoms would be incomplete.
const projectGroup = Effect.fn("RepoKnowledge.projectGroup")(function* (ids: ReadonlyArray<RepoId>, rulesAt: RulesAt) {
  const db = yield* Db.Db;
  let mints: Array<Db.MintClaim> = [];
  let waiting: Array<RepoId> = [];
  const written = yield* db.knowledge.project(ids, (locked, revision) =>
    Effect.gen(function* () {
      const rules = yield* rulesAt(revision);
      const labels = labelIndex(yield* db.knowledge.labels(locked.flatMap((repo) => lookupKeys(repo.claims, repo))));
      const projected = locked.map((repo) => ({
        repo,
        projection: project({ repo, facts: repo, claims: repo.claims, labels, rules }),
      }));
      const incomplete = projected.filter(({ projection }) => projection.mints.length > 0);
      waiting = incomplete.map(({ repo }) => repo.id);
      mints = incomplete.flatMap(({ repo, projection }) => {
        const receiptId = repo.receiptId;
        return receiptId === null ? [] : projection.mints.map((mint) => ({ ...mint, receiptId }));
      });
      return projected
        .filter(({ projection }) => projection.mints.length === 0)
        .map(({ repo, projection }) => ({
          repoId: repo.id,
          receiptId: repo.receiptId,
          atoms: projection.atoms,
          unresolvedKeys: projection.unresolvedKeys,
          verdicts: projection.verdicts,
        }));
    }),
  );
  return { projected: written.projected, mints, waiting };
});

// The rules a projection reads must be those of the revision it holds the shared lock at, since no decision commits
// while it holds it. The fold is cached by revision and refolded only when a decision lands between groups.
const rulesCache = (db: Db.Db["Service"]): RulesAt => {
  let cached: KnowledgeState | null = null;
  return (revision) =>
    cached !== null && cached.revision === revision
      ? Effect.succeed(cached)
      : Effect.map(db.knowledge.decisions, (decisions) => {
          cached = fold(decisions).state;
          return cached;
        });
};

// Projects these repos from their receipts and GitHub facts, with no model call. Repos that need new subjects get them
// minted under the exclusive lock, which marks stale every repo that looked their keys up, and are projected again.
const projectWith = Effect.fn("RepoKnowledge.projectWith")(function* (ids: ReadonlyArray<RepoId>, rulesAt: RulesAt) {
  const db = yield* Db.Db;
  const first = yield* projectGroup(ids, rulesAt);
  if (first.waiting.length === 0) return { projected: first.projected, minted: 0 };
  const { minted } = yield* db.knowledge.mint(first.mints);
  const second = yield* projectGroup(first.waiting, rulesAt);
  return { projected: first.projected + second.projected, minted: minted.length };
});

export const projectRepos = Effect.fn("RepoKnowledge.projectRepos")(function* (ids: ReadonlyArray<RepoId>) {
  return yield* projectWith(ids, rulesCache(yield* Db.Db));
});

// The projection sweep: up to groupsPerSweep groups of stale repos, lowest ID first.
export const reproject = Effect.fn("RepoKnowledge.reproject")(function* (
  options: { readonly groupSize: number; readonly groups: number } = { groupSize, groups: groupsPerSweep },
) {
  const db = yield* Db.Db;
  const rulesAt = rulesCache(db);
  let projected = 0;
  let minted = 0;
  for (let group = 0; group < options.groups; group++) {
    const ids = yield* db.knowledge.stale(options.groupSize);
    if (ids.length === 0) break;
    const result = yield* projectWith(ids, rulesAt);
    projected += result.projected;
    minted += result.minted;
    if (ids.length < options.groupSize) break;
  }
  return { projected, minted };
});

// The nightly count behind listing: every public subject's repo_count, from the same rows filters and chips read.
export const count = Effect.fn("RepoKnowledge.count")(function* () {
  const db = yield* Db.Db;
  return { changed: yield* db.knowledge.count };
});
