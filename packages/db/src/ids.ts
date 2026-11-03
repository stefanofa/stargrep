import * as Schema from "effect/Schema";

export const GitHubAccountId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("GitHubAccountId"));
export type GitHubAccountId = typeof GitHubAccountId.Type;

export const RepoId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("RepoId"));
export type RepoId = typeof RepoId.Type;

export const Login = Schema.NonEmptyString.pipe(Schema.brand("Login"));
export type Login = typeof Login.Type;

export const RepoName = Schema.NonEmptyString.pipe(Schema.brand("RepoName"));
export type RepoName = typeof RepoName.Type;

export const ObjectId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)),
  Schema.brand("ObjectId"),
);
export type ObjectId = typeof ObjectId.Type;

export const EmbeddingModel = Schema.NonEmptyString.pipe(Schema.brand("EmbeddingModel"));
export type EmbeddingModel = typeof EmbeddingModel.Type;
