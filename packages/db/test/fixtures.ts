import { GitHubAccountId, Login, ObjectId, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as Db from "../src/db.ts";
import { Embedding, EmbeddingModelId } from "../src/embedding.ts";

export const model = Schema.decodeSync(EmbeddingModelId)("test/embedding-1024");
export const otherModel = Schema.decodeSync(EmbeddingModelId)("test/other-embedding");
export const accountId = Schema.decodeSync(GitHubAccountId);
export const repoId = Schema.decodeSync(RepoId);
export const login = Schema.decodeSync(Login);
export const repoName = Schema.decodeSync(RepoName);
export const decodeWaiting = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ waiting: Schema.Int })));
export const readme = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
export const at = (iso: string) => DateTime.makeUnsafe(iso);
export const iso = (time: DateTime.Utc | null) => (time === null ? null : DateTime.formatIso(time));

export const embedding = (weights: Readonly<Record<number, number>>, embeddingModel = model) =>
  Schema.decodeSync(Embedding)({
    model: embeddingModel,
    vector: Array.from({ length: 1024 }, (_, index) => weights[index] ?? 0),
  });

export const account = (id: GitHubAccountId, facts: Partial<Db.AccountFacts> = {}): Db.AccountFacts => ({
  id,
  type: "user",
  login: login(`user-${id}`),
  name: null,
  avatarUrl: null,
  followers: null,
  publicRepos: null,
  ...facts,
});

export const ref = (id: RepoId, name = `repo-${id}`, nodeId = `R_${id}`): Db.RepoRef => ({
  id,
  nodeId: RepoNodeId.make(nodeId),
  owner: login("owner"),
  name: repoName(name),
});

export const facts = (id: RepoId): Db.RepoFacts => ({
  ...ref(id),
  description: null,
  topics: [],
  language: null,
  license: null,
  homepage: null,
  createdAt: null,
  pushedAt: null,
  archived: false,
  readmeOid: null,
});

export const stars = (accountId: GitHubAccountId): Db.SearchScope => ({ kind: "stars", accountId });

export const starred = (id: RepoId, starredAt: string, observedAt = starredAt): Db.StarEvent => ({
  repoId: id,
  starredAt: at(starredAt),
  observedAt: at(observedAt),
  source: "api",
});
