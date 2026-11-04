import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { apiHeaders } from "./headers.ts";
import { type Account, GitHubAccountId, GraphQLError, Login } from "./schemas.ts";

const query = `query Viewer {
  viewer {
    databaseId login name avatarUrl
    followers { totalCount }
    repositories(privacy: PUBLIC, ownerAffiliations: OWNER) { totalCount }
    starredRepositories { totalCount }
  }
}`;

const Total = Schema.Struct({ totalCount: Schema.Int });

const Viewer = Schema.Struct({
  databaseId: GitHubAccountId,
  login: Login,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  followers: Total,
  repositories: Total,
  starredRepositories: Total,
});

export const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optionalKey(Schema.NullOr(Schema.Struct({ viewer: Viewer }))),
      errors: Schema.optionalKey(Schema.Array(GraphQLError)),
    }),
  ),
);

export interface SignedInViewer {
  readonly account: Account;
  readonly starredCount: number;
}

export const toViewer = (viewer: typeof Viewer.Type): SignedInViewer => ({
  account: {
    id: viewer.databaseId,
    login: viewer.login,
    type: "user",
    name: viewer.name,
    avatarUrl: viewer.avatarUrl,
    followers: viewer.followers.totalCount,
    publicRepos: viewer.repositories.totalCount,
  },
  starredCount: viewer.starredRepositories.totalCount,
});

export const request = HttpClientRequest.post("https://api.github.com/graphql").pipe(
  HttpClientRequest.setHeaders(apiHeaders),
  HttpClientRequest.bodyJsonUnsafe({ query }),
);
