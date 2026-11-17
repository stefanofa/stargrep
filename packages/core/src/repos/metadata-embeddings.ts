import * as Embeddings from "@stargrep/ai/embeddings";
import * as Summarize from "@stargrep/ai/summarize";
import * as Db from "@stargrep/db";
import { Embedding } from "@stargrep/db/embedding";
import type { RepoId } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RateLine from "../limits/rate-line.ts";

const batchSize = 128;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

export const metadataEmbeddings = Metric.counter("stargrep_metadata_embeddings", {
  description: "Repos embedded from their metadata while their summaries wait, or refused by metadataAll, by outcome.",
});

const count = (outcome: "embedded" | "refused", repos: number) =>
  repos === 0 ? Effect.void : Metric.update(Metric.withAttributes(metadataEmbeddings, { outcome }), repos);

const embedBatch = Effect.fnUntraced(function* (batch: ReadonlyArray<Db.RepoMetadata>) {
  const db = yield* Db.Db;
  const embeddings = yield* Embeddings.Embeddings;
  const reserved = yield* RateLine.reserve(db.rateLines, RateLine.metadataAll, yield* DateTime.now, batch.length);
  if (Option.isNone(reserved)) return false;
  const vectors = yield* embeddings.embed(
    batch.map((repo) =>
      Summarize.metadataText({
        fullName: `${repo.owner}/${repo.name}`,
        description: repo.description,
        topics: repo.topics,
      }),
    ),
  );
  const decoded = yield* Effect.forEach(vectors, (vector) => Effect.orDie(decodeEmbedding(vector)));
  const saved = yield* db.repos.saveMetadataEmbeddings(
    Arr.zip(batch, decoded).map(([metadata, embedding]) => ({ metadata, embedding })),
  );
  yield* count("embedded", saved.length);
  return true;
});

// Embeds the metadata of each of these repos that waits for its summary and has nothing current to be searched by, so
// search finds it by meaning until its summary's embedding replaces this one. It embeds them in the order given, so a
// caller that stops it early leaves the last ones waiting. Each repo takes a unit of metadataAll, not of the summary
// cap. A batch the line refuses, a failed call, or a failed write only logs, and the repos wait for the next attempt
// that reaches them, so this never fails its caller.
export const embed = Effect.fn("MetadataEmbeddings.embed")(
  function* (ids: ReadonlyArray<RepoId>) {
    const db = yield* Db.Db;
    const batches = Arr.chunksOf(yield* db.repos.metadataDue(ids), batchSize);
    for (const [index, batch] of batches.entries()) {
      if (yield* embedBatch(batch)) continue;
      const refused = batches.slice(index).flat().length;
      yield* count("refused", refused);
      yield* Effect.logWarning(`Metadata embedding line reached, ${refused} repos waiting`, {
        waiting: refused,
        perDay: RateLine.metadataEmbeddingsPerDay,
      });
      return;
    }
  },
  Effect.catch((error) => Effect.logWarning("Metadata embedding failed", { error: error._tag, detail: error.message })),
);
