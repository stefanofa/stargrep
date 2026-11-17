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

// metadataAll pays out about 700 units between two runs of the 10-minute sweep, so a run takes up to 1,024 repos and
// keeps pace with the line.
export const sweepBatch = 8 * batchSize;

const decodeEmbedding = Schema.decodeUnknownEffect(Embedding);

export const metadataEmbeddings = Metric.counter("stargrep_metadata_embeddings", {
  description: "Repos embedded from their metadata while their summaries wait, or refused by metadataAll, by outcome.",
});

const count = (outcome: "embedded" | "refused", repos: number) =>
  repos === 0 ? Effect.void : Metric.update(Metric.withAttributes(metadataEmbeddings, { outcome }), repos);

const embedBatch = Effect.fnUntraced(function* (batch: ReadonlyArray<Db.RepoMetadata>) {
  const db = yield* Db.Db;
  const embeddings = yield* Embeddings.Embeddings;
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
  return saved.length;
});

// Embeds the metadata of each of these repos that waits for its summary and has nothing current to be searched by, so
// search finds it by meaning until its summary's embedding replaces this one. It embeds them in the order given, so a
// caller that stops it early leaves the last ones waiting. Each repo takes a unit of metadataAll, not of the summary
// cap. A batch the line refuses, a failed call, or a failed write only logs, and the repos stay due for the sweep below,
// so this never fails its caller.
export const embed = Effect.fn("MetadataEmbeddings.embed")(
  function* (ids: ReadonlyArray<RepoId>) {
    const db = yield* Db.Db;
    const batches = Arr.chunksOf(yield* db.repos.metadataDue(ids), batchSize);
    for (const [index, batch] of batches.entries()) {
      const reserved = yield* RateLine.reserve(db.rateLines, RateLine.metadataAll, yield* DateTime.now, batch.length);
      if (Option.isSome(reserved)) {
        yield* embedBatch(batch);
        continue;
      }
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

// Embeds every one of these repos that is due, as embed does, but takes no unit of metadataAll, which stays for the
// Worker, and fails with the first batch that fails. A bulk import on a developer's machine tries the account again
// until none is due. Returns how many it saved.
export const embedUnmetered = Effect.fn("MetadataEmbeddings.embedUnmetered")(function* (ids: ReadonlyArray<RepoId>) {
  const db = yield* Db.Db;
  let saved = 0;
  for (const batch of Arr.chunksOf(yield* db.repos.metadataDue(ids), batchSize)) saved += yield* embedBatch(batch);
  return saved;
});

// Embeds the lowest-ID repos due a metadata embedding, whatever the summary policy and the failure cap say, so a repo
// whose embedding failed or that metadataAll refused gets it once the line has room, even one no other sweep sends.
export const sweep = Effect.fn("MetadataEmbeddings.sweep")(function* () {
  const db = yield* Db.Db;
  const due = yield* db.repos.metadataSweepable(sweepBatch);
  yield* embed(due);
  return { due: due.length };
});
