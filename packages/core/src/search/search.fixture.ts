import * as Embeddings from "@stargrep/ai/embeddings";
import * as Fake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import { Embedding } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { summarize } from "@stargrep/db/testing";
import { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { projectRepos } from "../knowledge/repo-knowledge.ts";
import type * as Search from "./search.ts";

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);
export interface Seed {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
  readonly language: string;
  readonly starredAt: string;
  readonly stars?: number;
  readonly kind?: string;
  readonly license?: string;
}

export const seedLibrary = Effect.fn("test.seedLibrary")(function* (account: number, repos: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  const database = yield* TestDatabase.TestDatabase;
  const embeddings = yield* Embeddings.Embeddings;
  const accountId = GitHubAccountId.make(account);
  const login = Login.make(`user-${account}`);
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login,
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  for (const repo of repos) {
    const id = RepoId.make(repo.id);
    const ref = {
      id,
      nodeId: RepoNodeId.make(`R_${repo.id}`),
      owner: Login.make("owner"),
      name: RepoName.make(repo.name),
    };
    yield* db.repos.upsertRefs([ref]);
    yield* db.repos.saveFacts({
      ...ref,
      description: null,
      topics: [],
      language: repo.language,
      license: repo.license ?? null,
      homepage: null,
      createdAt: null,
      pushedAt: null,
      archived: false,
      readmeOid: null,
      ownerType: null,
      ownerAvatarUrl: null,
    });
    yield* summarize({
      id,
      readmeOid: null,
      summary: repo.summary,
      keywords: [],
      kind: repo.kind ?? "library",
    });
    const [vector] = yield* embeddings.embed([repo.summary]);
    const input = {
      id,
      owner: ref.owner,
      name: ref.name,
      embedding: yield* decodeEmbedding({ model: embeddings.model.id, vector: vector?.vector }),
      summary: repo.summary,
      keywords: [],
      description: null,
      readmeOid: null,
    };
    yield* db.repos.saveEmbedding(input);
    if (repo.stars !== undefined) {
      yield* database.query(
        "insert into repo_metrics (repo_id, stars, stars_90d, refreshed_at) values ($1, $2, $3, now())",
        [repo.id, repo.stars, repo.stars / 10],
      );
    }
  }
  yield* projectRepos(repos.map((repo) => RepoId.make(repo.id)));
  yield* db.stars.upsert({
    accountId,
    stars: repos.map((repo) => ({
      repoId: RepoId.make(repo.id),
      starredAt: DateTime.makeUnsafe(repo.starredAt),
      observedAt: DateTime.makeUnsafe(repo.starredAt),
      source: "api" as const,
    })),
  });
  return { _tag: "stars", login } satisfies Search.Scope;
});

export const recordingEmbeddings = (record: (texts: ReadonlyArray<string>) => void) =>
  Layer.effect(
    Embeddings.Embeddings,
    Effect.map(Embeddings.Embeddings, (inner) =>
      Embeddings.Embeddings.of({
        model: inner.model,
        embed: Effect.fn("test.embed")((values: ReadonlyArray<string>) =>
          Effect.sync(() => record(values)).pipe(Effect.andThen(inner.embed(values))),
        ),
      }),
    ),
  ).pipe(Layer.provide(Fake.layerEmbeddings()));
