import * as Schema from "effect/Schema";
import { Account, GitHubAccountId, Login } from "./schemas.ts";

export const userFields = `databaseId
      login
      name
      avatarUrl
      followers { totalCount }
      repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
      starredRepositories { totalCount }`;

// One request answers whether the login exists, whether it is a user or an org, its facts, and its starred total.
// GraphQL's Organization has no follower count.
export const query = `query Owner($login: String!) {
  repositoryOwner(login: $login) {
    __typename
    ... on User {
      ${userFields}
    }
    ... on Organization {
      databaseId
      login
      name
      avatarUrl
      repositories(privacy: PUBLIC) { totalCount }
    }
  }
}`;

const Count = Schema.Struct({ totalCount: Schema.Int });

const Facts = {
  databaseId: GitHubAccountId,
  login: Login,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  repositories: Count,
};

export const User = Schema.Struct({
  __typename: Schema.Literal("User"),
  ...Facts,
  followers: Count,
  starredRepositories: Count,
});

const Organization = Schema.Struct({ __typename: Schema.Literal("Organization"), ...Facts });

export const Data = Schema.Struct({ repositoryOwner: Schema.NullOr(Schema.Union([User, Organization])) });

export const Owner = Schema.Struct({ account: Account, starredTotal: Schema.Int });
export type Owner = typeof Owner.Type;

// Crosses the RPC boundary between the Workers as plain data. Failures are values, so the caller never has to read an
// RPC error envelope.
export const OwnerReply = Schema.Union([
  Schema.TaggedStruct("Found", { owner: Owner }),
  Schema.TaggedStruct("Missing", {}),
  Schema.TaggedStruct("Unavailable", { reason: Schema.Literals(["budget", "github"]) }),
]);
export type OwnerReply = typeof OwnerReply.Type;

// An org cannot star repos, so its total is 0.
export const toOwner = (node: typeof User.Type | typeof Organization.Type): Owner => ({
  account: {
    id: node.databaseId,
    login: node.login,
    type: node.__typename === "User" ? "user" : "org",
    name: node.name,
    avatarUrl: node.avatarUrl,
    followers: node.__typename === "User" ? node.followers.totalCount : null,
    publicRepos: node.repositories.totalCount,
  },
  starredTotal: node.__typename === "User" ? node.starredRepositories.totalCount : 0,
});
