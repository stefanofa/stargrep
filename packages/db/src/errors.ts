import * as Schema from "effect/Schema";
import { EmbeddingModel, GitHubAccountId, RepoId } from "./ids.ts";

export const Operation = Schema.Literals([
  "transaction",
  "accounts.upsert",
  "accounts.get",
  "accounts.recordStarSync",
  "repos.upsertRefs",
  "repos.saveFacts",
  "repos.saveSummary",
  "repos.saveEmbedding",
  "repos.get",
  "stars.upsert",
  "stars.markUnstarred",
  "stars.list",
  "search.nearestStars",
  "search.hybridStars",
  "usage.increment",
  "usage.get",
]);
export type Operation = typeof Operation.Type;

export class DbQueryFailed extends Schema.TaggedError<DbQueryFailed, { readonly brand: unique symbol }>()(
  "DbQueryFailed",
  {
    operation: Operation,
    reason: Schema.Literals(["transport", "timeout", "constraint", "query"]),
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
  },
) {
  override get message(): string {
    return `Db '${this.operation}' read a row that does not match its schema`;
  }
}

export class EmbeddingModelMismatch extends Schema.TaggedError<
  EmbeddingModelMismatch,
  { readonly brand: unique symbol }
>()("EmbeddingModelMismatch", {
  expected: EmbeddingModel,
  received: EmbeddingModel,
}) {
  override get message(): string {
    return `The database holds '${this.expected}' embeddings and refuses a vector from '${this.received}'`;
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
