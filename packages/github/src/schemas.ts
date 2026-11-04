import * as Schema from "effect/Schema";

const makeGitHubId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand<Brand>(brand));

export const RepoId = makeGitHubId("RepoId");
export type RepoId = typeof RepoId.Type;

export const GitHubAccountId = makeGitHubId("GitHubAccountId");
export type GitHubAccountId = typeof GitHubAccountId.Type;

export const RepoNodeId = Schema.NonEmptyString.pipe(Schema.brand("RepoNodeId"));
export type RepoNodeId = typeof RepoNodeId.Type;

export const Login = Schema.NonEmptyString.pipe(Schema.brand("Login"));
export type Login = typeof Login.Type;

export const RepoName = Schema.NonEmptyString.pipe(Schema.brand("RepoName"));
export type RepoName = typeof RepoName.Type;

export const ObjectId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)),
  Schema.brand("ObjectId"),
);
export type ObjectId = typeof ObjectId.Type;

export const BudgetShare = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  Schema.brand("BudgetShare"),
);
export type BudgetShare = typeof BudgetShare.Type;

export const Repo = Schema.Struct({
  id: RepoId,
  nodeId: RepoNodeId,
  owner: Login,
  name: RepoName,
});
export type Repo = typeof Repo.Type;

export const Account = Schema.Struct({
  id: GitHubAccountId,
  login: Login,
  type: Schema.Literals(["user", "org"]),
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  followers: Schema.Int,
  publicRepos: Schema.Int,
});
export type Account = typeof Account.Type;

export const Star = Schema.Struct({
  starredAt: Schema.DateTimeUtcFromString,
  repo: Repo,
});
export type Star = typeof Star.Type;

export const Readme = Schema.Struct({
  name: Schema.String,
  oid: ObjectId,
});
export type Readme = typeof Readme.Type;

export const RepoFacts = Schema.Struct({
  ...Repo.fields,
  description: Schema.NullOr(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  license: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  pushedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  stars: Schema.Int,
  forks: Schema.Int,
  readme: Schema.NullOr(Readme),
});
export type RepoFacts = typeof RepoFacts.Type;

export const RateLimit = Schema.Struct({
  resource: Schema.String,
  limit: Schema.Int,
  remaining: Schema.Int,
  resetAt: Schema.Int,
});
export type RateLimit = typeof RateLimit.Type;

export const IntFromString = Schema.NumberFromString.pipe(Schema.check(Schema.isInt()));
