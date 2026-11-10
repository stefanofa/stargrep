import { GitHubAccountId, Login, ObjectId, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import { AtomKey, type ClosedAtom, isClosed, SelectionKey } from "@stargrep/knowledge/atom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Db from "../src/db.ts";
import { anyDistance, Embedding, EmbeddingModelId } from "../src/embedding.ts";

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
  ownerType: null,
  ownerAvatarUrl: null,
});

export const stars = (accountId: GitHubAccountId): Db.SearchScope => ({ kind: "stars", accountId });

export const starred = (id: RepoId, starredAt: string, observedAt = starredAt): Db.StarEvent => ({
  repoId: id,
  starredAt: at(starredAt),
  observedAt: at(observedAt),
  source: "api",
});

export const hybrid = (
  search: Pick<Db.HybridSearch, "scope" | "text" | "embedding" | "limit"> & Partial<Db.HybridSearch>,
): Db.HybridSearch => ({
  maxDistance: anyDistance,
  name: null,
  metrics: [],
  filters: Db.noFilters,
  atoms: Db.noAtoms,
  rankBy: null,
  ...search,
});

const decodeAtom = Schema.decodeSync(AtomKey);

// Closed atoms the query stated, ORed, as the compiler gives them.
const closedAtom = (key: string): ClosedAtom => {
  const atom = decodeAtom(key);
  if (!isClosed(atom)) throw new Error(`${key} is not a closed atom`);
  return atom;
};

export const closedGroup = (mode: Db.GroupMode, ...keys: readonly [string, ...Array<string>]): Db.ClosedGroup => ({
  _tag: "Closed",
  mode,
  any: [closedAtom(keys[0]), ...keys.slice(1).map(closedAtom)],
});

// The caller's selection, from its key, such as "lang:rust -kind:list".
export const selection = Schema.decodeSync(SelectionKey);

export const searchHits = (search: Db.HybridSearch) =>
  Effect.flatMap(Effect.service(Db.Db), (db) => db.search.hybrid(search)).pipe(Effect.map(({ hits }) => hits));

export const accountRow = (id: GitHubAccountId, overrides: Partial<Db.Account> = {}): Db.Account => ({
  ...account(id),
  ownedRepoStars: null,
  claimedBy: null,
  starredCount: null,
  starsSyncedAt: null,
  starsFullSyncedAt: null,
  ...overrides,
});

export const repo = (id: RepoId, overrides: Partial<Db.Repo> = {}): Db.Repo => ({
  ...facts(id),
  nodeId: RepoNodeId.make(`R_${id}`),
  kind: null,
  summary: null,
  summaryReadmeOid: null,
  keywords: [],
  embeddingModel: null,
  icon: null,
  iconCheckedAt: null,
  ...overrides,
});
