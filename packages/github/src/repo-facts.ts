import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { rankIconFiles } from "./icon-files.ts";
import { pickReadme, TreeEntry } from "./readme.ts";
import { GraphQLError, Login, type RepoFacts, RepoId, RepoName, RepoNodeId } from "./schemas.ts";

// GitHub cuts a GraphQL query off at 10 s. With topics and the root tree,
// 25 repos measured 2.4 s and 100 repos timed out.
export const batchSize = 25;

const query = `query RepoFacts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      databaseId
      id
      name
      owner { __typename login avatarUrl }
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
  owner: Schema.Struct({
    __typename: Schema.Literals(["User", "Organization"]),
    login: Login,
    avatarUrl: Schema.String,
  }),
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

const Response = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.NullOr(RepoNode)) }))),
  errors: Schema.optionalKey(Schema.Array(GraphQLError)),
});
type Response = typeof Response.Type;

export const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

export const request = (ids: ReadonlyArray<RepoNodeId>) =>
  HttpClientRequest.post("https://api.github.com/graphql").pipe(
    HttpClientRequest.bodyJsonUnsafe({ query, variables: { ids } }),
  );

const toFacts = (node: RepoNode): RepoFacts => ({
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
  iconFiles: rankIconFiles(node.root?.entries ?? [], node.name),
  ownerType: node.owner.__typename === "Organization" ? "org" : "user",
  ownerAvatarUrl: node.owner.avatarUrl,
});

interface NodeError {
  readonly kind: "NOT_FOUND" | "FORBIDDEN";
  readonly index: number;
}

const nodeError = (error: GraphQLError): NodeError | null => {
  const [field, index] = error.path ?? [];
  if (field !== "nodes" || typeof index !== "number") return null;
  return error.type === "NOT_FOUND" || error.type === "FORBIDDEN" ? { kind: error.type, index } : null;
};

export const settle = (ids: ReadonlyArray<RepoNodeId>, body: Response) => {
  const classified = (body.errors ?? []).map((error) => ({ error, node: nodeError(error) }));
  const forbidden = new Set(classified.flatMap(({ node }) => (node?.kind === "FORBIDDEN" ? [node.index] : [])));
  return {
    facts: (body.data?.nodes ?? []).flatMap((node, index) =>
      node === null || forbidden.has(index) ? [] : [toFacts(node)],
    ),
    forbidden: ids.filter((_, index) => forbidden.has(index)),
    errors: classified.flatMap(({ error, node }) => (node === null ? [error] : [])),
  };
};
