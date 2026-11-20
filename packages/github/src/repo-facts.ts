import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { rankIconFiles } from "./icon-files.ts";
import { pickReadme, TreeEntry } from "./readme.ts";
import { type GraphQLError, Login, type RepoFacts, RepoId, RepoName, RepoNodeId } from "./schemas.ts";

// GitHub cuts a GraphQL query off at 10 s. With topics and the root tree,
// 25 repos measured 2.4 s and 100 repos timed out.
export const batchSize = 25;

const fields = `databaseId
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
      isPrivate
      stargazerCount
      forkCount
      root: object(expression: "HEAD:") { ... on Tree { entries { name type oid } } }`;

export const query = `query RepoFacts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      ${fields}
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
  // GitHub's schema lets the list and each of its items be null.
  repositoryTopics: Schema.Struct({
    nodes: Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })))),
  }),
  createdAt: Schema.DateTimeUtcFromString,
  pushedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  isArchived: Schema.Boolean,
  isFork: Schema.Boolean,
  isPrivate: Schema.Boolean,
  stargazerCount: Schema.Int,
  forkCount: Schema.Int,
  // GitHub's schema lets a tree's entries be null.
  root: Schema.NullOr(Schema.Struct({ entries: Schema.optionalKey(Schema.NullOr(Schema.Array(TreeEntry))) })),
});
type RepoNode = typeof RepoNode.Type;

// Each node decodes on its own, after the batch's errors are read, so one repo's odd shape never fails its batch.
export const Data = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) });

const decodeNode = Schema.decodeUnknownResult(Schema.NullOr(RepoNode));

// A repo GitHub sent in a shape the decoder refuses, and the decoder's reason.
export interface Invalid<Key> {
  readonly key: Key;
  readonly issue: string;
}

const toFacts = (node: RepoNode): RepoFacts => ({
  id: node.databaseId,
  nodeId: node.id,
  owner: node.owner.login,
  name: node.name,
  description: node.description,
  homepage: node.homepageUrl || null,
  language: node.primaryLanguage?.name ?? null,
  license: node.licenseInfo?.spdxId ?? null,
  topics: (node.repositoryTopics.nodes ?? []).flatMap((entry) => (entry === null ? [] : [entry.topic.name])),
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

export const nodeError = (error: GraphQLError): NodeError | null => {
  const [field, index] = error.path ?? [];
  if (field !== "nodes" || typeof index !== "number") return null;
  return error.type === "NOT_FOUND" || error.type === "FORBIDDEN" ? { kind: error.type, index } : null;
};

// A private repo is forbidden whatever token read it. A personal token reads its owner's private repos, and nothing
// private may reach a model, the blob store, or a public table, so every caller of a facts read sees it as forbidden.
export const settle = (
  ids: ReadonlyArray<RepoNodeId>,
  body: { readonly data?: typeof Data.Type | null; readonly errors?: ReadonlyArray<GraphQLError> },
) => {
  const classified = (body.errors ?? []).map((error) => ({ error, node: nodeError(error) }));
  const nodes = (body.data?.nodes ?? []).map((node) => decodeNode(node));
  const forbidden = new Set([
    ...classified.flatMap(({ node }) => (node?.kind === "FORBIDDEN" ? [node.index] : [])),
    ...nodes.flatMap((node, index) => (Result.isSuccess(node) && node.success?.isPrivate === true ? [index] : [])),
  ]);
  return {
    facts: nodes.flatMap((node, index) =>
      Result.isFailure(node) || node.success === null || forbidden.has(index) ? [] : [toFacts(node.success)],
    ),
    forbidden: ids.filter((_, index) => forbidden.has(index)),
    invalid: Arr.zip(ids, nodes).flatMap(
      ([key, node], index): Array<Invalid<RepoNodeId>> =>
        Result.isFailure(node) && !forbidden.has(index) ? [{ key, issue: node.failure.message }] : [],
    ),
    errors: classified.flatMap(({ error, node }) => (node === null ? [error] : [])),
  };
};

// A repo an archive names by numeric ID and full name, before Stargrep knows its node ID.
export interface ArchiveRef {
  readonly id: RepoId;
  readonly owner: Login;
  readonly name: RepoName;
}

// Why an archive ref resolved to no repo: GitHub has no repo by that name, the token may not read it or the repo is
// private, the name now belongs to a repo with another ID, such as one created after the archived repo was deleted or
// renamed away, or GitHub sent its facts in a shape the decoder refuses or left them unanswered even alone.
export type Unresolved = {
  readonly id: RepoId;
  readonly reason: "missing" | "forbidden" | "other-repo" | "invalid";
};

const alias = (index: number) => `r${index}`;

// One aliased lookup per ref, by owner and name, with the same fields as a facts batch.
export const resolveQuery = (count: number) => {
  const variables = Array.from({ length: count }, (_, index) => `$o${index}: String!, $n${index}: String!`);
  const lookups = Array.from(
    { length: count },
    (_, index) => `  ${alias(index)}: repository(owner: $o${index}, name: $n${index}) {
      ${fields}
  }`,
  );
  return `query ResolveRepos(${variables.join(", ")}) {\n${lookups.join("\n")}\n}`;
};

export const resolveVariables = (refs: ReadonlyArray<ArchiveRef>) =>
  Object.fromEntries(
    refs.flatMap((ref, index) => [
      [`o${index}`, ref.owner],
      [`n${index}`, ref.name],
    ]),
  );

export const ResolveData = Schema.Record(Schema.String, Schema.Unknown);

const aliasError = (error: GraphQLError) => {
  const [field] = error.path ?? [];
  return typeof field === "string" && /^r\d+$/.test(field) && (error.type === "NOT_FOUND" || error.type === "FORBIDDEN")
    ? { index: Number(field.slice(1)), kind: error.type }
    : null;
};

export const isAliasError = (error: GraphQLError) => aliasError(error) !== null;

// Keeps a repo only when GitHub's databaseId equals the archive's ID, so a name that now points at another repo never
// lends that repo's facts to the archived one.
export const settleResolved = (
  refs: ReadonlyArray<ArchiveRef>,
  body: { readonly data: typeof ResolveData.Type; readonly errors: ReadonlyArray<GraphQLError> },
) => {
  const forbidden = new Set(
    body.errors.flatMap((error) => {
      const found = aliasError(error);
      return found?.kind === "FORBIDDEN" ? [found.index] : [];
    }),
  );
  const facts: Array<RepoFacts> = [];
  const unresolved: Array<Unresolved> = [];
  const invalid: Array<Invalid<RepoId>> = [];
  refs.forEach((ref, index) => {
    const decoded = decodeNode(body.data[alias(index)] ?? null);
    const node = Result.getOrNull(decoded);
    if (forbidden.has(index) || node?.isPrivate === true) unresolved.push({ id: ref.id, reason: "forbidden" });
    else if (Result.isFailure(decoded)) {
      unresolved.push({ id: ref.id, reason: "invalid" });
      invalid.push({ key: ref.id, issue: decoded.failure.message });
    } else if (node === null) unresolved.push({ id: ref.id, reason: "missing" });
    else if (node.databaseId !== ref.id) unresolved.push({ id: ref.id, reason: "other-repo" });
    else facts.push(toFacts(node));
  });
  return { facts, unresolved, invalid };
};
