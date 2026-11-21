import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import { Revision } from "@stargrep/knowledge/ids";
import * as Schema from "effect/Schema";

export const Operation = Schema.Literals([
  "transaction",
  "accounts.upsert",
  "accounts.upsertLooked",
  "accounts.claim",
  "accounts.claimedBy",
  "accounts.get",
  "accounts.byLogin",
  "accounts.require",
  "accounts.setOwnedRepoStars",
  "accounts.recordStarSync",
  "accounts.setStarredCount",
  "repos.upsertRefs",
  "repos.saveListed",
  "repos.markUserStarred",
  "repos.pendingEnrichment",
  "repos.saveFacts",
  "repos.saveFactsAndLease",
  "repos.summarized",
  "repos.saveCounts",
  "repos.saveEmbedding",
  "repos.metadataDue",
  "repos.saveMetadataEmbeddings",
  "repos.metadataSweepable",
  "repos.saveIcon",
  "repos.markIconChecked",
  "repos.saveOwners",
  "repos.dueIcons",
  "repos.get",
  "repos.require",
  "repos.getMany",
  "repos.recordEnrichFailures",
  "repos.sweepable",
  "repos.inSummaryOrder",
  "repos.lease",
  "repos.settleFailures",
  "repos.defer",
  "repos.summaryBacklog",
  "repos.pendingSummaries",
  "repos.summaryCandidates",
  "stars.upsert",
  "stars.applySnapshot",
  "stars.list",
  "stars.library",
  "stars.page",
  "stars.enrichment",
  "stars.newToYou",
  "search.acceptedKeys",
  "search.hybrid",
  "search.matchesAsPrefix",
  "search.nearNames",
  "similar.opened",
  "similar.inStars",
  "similar.notStarred",
  "similar.apart",
  "syncRequests.get",
  "syncRequests.claim",
  "syncRequests.prune",
  "syncRequests.ahead",
  "syncRequests.schedule",
  "syncRequests.settle",
  "rateLines.wait",
  "rateLines.reserve",
  "rateLines.release",
  "rateLines.prune",
  "usage.increment",
  "usage.get",
  "settings.adopt",
  "knowledge.capture",
  "knowledge.prepareBatch",
  "knowledge.submittedBatch",
  "knowledge.openBatches",
  "knowledge.extendBatch",
  "knowledge.closeBatch",
  "knowledge.dropBatch",
  "knowledge.moveLease",
  "knowledge.claimPrefill",
  "knowledge.heartbeatPrefill",
  "knowledge.releasePrefill",
  "knowledge.recordFailed",
  "knowledge.mint",
  "knowledge.labels",
  "knowledge.project",
  "knowledge.stale",
  "knowledge.count",
  "knowledge.countAtoms",
  "knowledge.allocate",
  "knowledge.revision",
  "knowledge.decide",
  "knowledge.decisions",
  "knowledge.rules",
  "knowledge.subjects",
  "knowledge.minted",
  "knowledge.reach",
  "knowledge.examples",
  "knowledge.floor",
  "knowledge.variants",
  "facets.held",
  "facets.matching",
  "facets.lookup",
  "monthlyPicks.optedIn",
  "monthlyPicks.set",
  "starImports.claim",
  "starImports.heartbeat",
  "starImports.release",
  "iconBackfill.start",
  "iconBackfill.advance",
]);
export type Operation = typeof Operation.Type;

export class DbQueryFailed extends Schema.TaggedError<DbQueryFailed, { readonly brand: unique symbol }>()(
  "DbQueryFailed",
  {
    operation: Operation,
    reason: Schema.Literals(["transport", "timeout", "conflict", "constraint", "query"]),
    sqlState: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Db '${this.operation}' failed: ${this.reason}${this.sqlState === null ? "" : ` ${this.sqlState}`}`;
  }
}

export class DbRowInvalid extends Schema.TaggedError<DbRowInvalid, { readonly brand: unique symbol }>()(
  "DbRowInvalid",
  {
    operation: Operation,
    column: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Db '${this.operation}' read a row that does not match its schema${this.column === null ? "" : ` in '${this.column}'`}`;
  }
}

export class RepoNotFound extends Schema.TaggedError<RepoNotFound, { readonly brand: unique symbol }>()(
  "RepoNotFound",
  {
    repoId: RepoId,
  },
) {
  override get message(): string {
    return `Repo ${this.repoId} does not exist`;
  }
}

export class AccountNotFound extends Schema.TaggedError<AccountNotFound, { readonly brand: unique symbol }>()(
  "AccountNotFound",
  {
    accountId: GitHubAccountId,
  },
) {
  override get message(): string {
    return `GitHub account ${this.accountId} does not exist`;
  }
}

export class StaleRevision extends Schema.TaggedError<StaleRevision, { readonly brand: unique symbol }>()(
  "StaleRevision",
  {
    expected: Revision,
    head: Revision,
  },
) {
  override get message(): string {
    return `A decision expected curation revision ${this.expected}, but the log is at ${this.head}`;
  }
}

// A decision gives a subject a label key that projection already minted for another subject. That is a merge, which
// keeps both IDs stable, not an alias.
export class KeyMinted extends Schema.TaggedError<KeyMinted, { readonly brand: unique symbol }>()("KeyMinted", {
  key: Schema.String,
  subjectId: Schema.Int,
  holder: Schema.Int,
}) {
  override get message(): string {
    return `Label key '${this.key}' for subject ${this.subjectId} is already minted for subject ${this.holder}`;
  }
}
