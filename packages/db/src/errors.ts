import { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as Schema from "effect/Schema";

export const Operation = Schema.Literals([
  "transaction",
  "accounts.upsert",
  "accounts.get",
  "accounts.byLogin",
  "accounts.require",
  "accounts.setOwnedRepoStars",
  "accounts.recordStarSync",
  "repos.upsertRefs",
  "repos.pendingEnrichment",
  "repos.saveFacts",
  "repos.saveSummary",
  "repos.saveEmbedding",
  "repos.get",
  "repos.getMany",
  "stars.upsert",
  "stars.applySnapshot",
  "stars.list",
  "search.hybrid",
  "usage.increment",
  "usage.get",
  "settings.adopt",
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
