import * as Models from "@stargrep/ai/models";
import { RepoKnowledge } from "@stargrep/core/knowledge";
import * as Db from "@stargrep/db";
import { Embedding, EmbeddingModelId } from "@stargrep/db/embedding";
import { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EnrichedRepo } from "./enriched-corpus.ts";

// The one account the evals load a corpus into, as its stars.
const accountId = GitHubAccountId.make(1);
const login = Login.make("recall-eval");
export const scope = { _tag: "stars", login } as const;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);
export const embeddingModelId = Schema.decodeSync(EmbeddingModelId)(Models.embeddingModel.id);

const starredAt = (index: number) =>
  DateTime.add(DateTime.makeUnsafe("2024-01-01T00:00:00Z"), { days: (index * 37) % 1030 });

// Saves each repo as enrichment does, captures its recorded facts and projects them, and stars it for the account.
export const loadAccount = Effect.fn("Evals.loadAccount")(function* (repos: ReadonlyArray<EnrichedRepo>) {
  const db = yield* Db.Db;
  const rows = [...repos]
    .sort((left, right) => left.fullName.localeCompare(right.fullName))
    .map((repo, index) => {
      const [owner = "", name = ""] = repo.fullName.split("/");
      const id = RepoId.make(index + 1);
      return {
        repo,
        ref: { id, nodeId: RepoNodeId.make(`R_recall_${id}`), owner: Login.make(owner), name: RepoName.make(name) },
      };
    });
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login,
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  yield* db.repos.upsertRefs(rows.map((row) => row.ref));
  yield* Effect.forEach(
    rows,
    ({ repo, ref }) =>
      Effect.gen(function* () {
        const { inputHash } = yield* db.repos.saveFacts({
          ...ref,
          description: repo.description,
          topics: repo.topics,
          language: repo.language,
          license: null,
          homepage: null,
          createdAt: null,
          pushedAt: null,
          archived: false,
          readmeOid: null,
          ownerType: null,
          ownerAvatarUrl: null,
        });
        yield* RepoKnowledge.accept([
          {
            repoId: ref.id,
            readmeOid: null,
            inputHash,
            source: "model",
            model: Models.summaryModel,
            answer: {
              summary: repo.summary,
              keywords: repo.keywords,
              facets: repo.facets,
            },
            lease: null,
          },
        ]);
        const embedding = yield* decodeEmbedding({ model: embeddingModelId, vector: repo.vector }).pipe(Effect.orDie);
        yield* db.repos.saveEmbedding({
          id: ref.id,
          owner: ref.owner,
          name: ref.name,
          embedding,
          summary: repo.summary,
          keywords: repo.keywords,
          description: repo.description,
          readmeOid: null,
        });
      }),
    { concurrency: 8, discard: true },
  );
  yield* db.stars.upsert({
    accountId,
    stars: rows.map(({ ref }, index) => ({
      repoId: ref.id,
      starredAt: starredAt(index),
      observedAt: starredAt(index),
      source: "api",
    })),
  });
});
