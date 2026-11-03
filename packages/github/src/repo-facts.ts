import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { pickReadme, TreeEntry } from "./readme.ts";
import { Login, type RepoFacts, RepoId, RepoName, RepoNodeId } from "./schemas.ts";

// GitHub cuts a GraphQL query off at 10 s. With topics and the root tree,
// 25 repos measured 2.4 s and 100 repos timed out.
export const batchSize = 25;

const query = `query RepoFacts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      databaseId
      id
      name
      owner { login }
      description
      homepageUrl
      primaryLanguage { name }
      licenseInfo { spdxId }
      repositoryTopics(first: 20) { nodes { topic { name } } }
      createdAt
      pushedAt
      isArchived
      isFork
      stargazerCount
      forkCount
      root: object(expression: "HEAD:") { ... on Tree { entries { name type oid } } }
    }
  }
}`;

const RepoNode = Schema.Struct({
  databaseId: RepoId,
  id: RepoNodeId,
  name: RepoName,
  owner: Schema.Struct({ login: Login }),
  description: Schema.NullOr(Schema.String),
  homepageUrl: Schema.NullOr(Schema.String),
  primaryLanguage: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  licenseInfo: Schema.NullOr(Schema.Struct({ spdxId: Schema.NullOr(Schema.String) })),
  repositoryTopics: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })),
  }),
  createdAt: Schema.DateTimeUtcFromString,
  pushedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  isArchived: Schema.Boolean,
  isFork: Schema.Boolean,
  stargazerCount: Schema.Int,
  forkCount: Schema.Int,
  root: Schema.NullOr(Schema.Struct({ entries: Schema.optionalKey(Schema.Array(TreeEntry)) })),
});
type RepoNode = typeof RepoNode.Type;

const GraphQLError = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  message: Schema.String,
});

export const decodeResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.NullOr(RepoNode)) }))),
    errors: Schema.optionalKey(Schema.Array(GraphQLError)),
  }),
);

export const request = (ids: ReadonlyArray<RepoNodeId>) =>
  HttpClientRequest.post("https://api.github.com/graphql").pipe(
    HttpClientRequest.bodyJsonUnsafe({ query, variables: { ids } }),
  );

export const toFacts = (node: RepoNode): RepoFacts => ({
  id: node.databaseId,
  nodeId: node.id,
  owner: node.owner.login,
  name: node.name,
  description: node.description,
  homepage: node.homepageUrl || null,
  language: node.primaryLanguage?.name ?? null,
  license: node.licenseInfo?.spdxId ?? null,
  topics: node.repositoryTopics.nodes.map((entry) => entry.topic.name),
  createdAt: node.createdAt,
  pushedAt: node.pushedAt,
  archived: node.isArchived,
  fork: node.isFork,
  stars: node.stargazerCount,
  forks: node.forkCount,
  readme: pickReadme(node.root?.entries ?? []),
});
