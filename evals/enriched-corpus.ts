import * as Embeddings from "@stargrep/ai/embeddings";
import * as Summarize from "@stargrep/ai/summarize";
import { Float32Vector } from "@stargrep/db/embedding";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Corpus from "./corpus.ts";

export const EnrichedRepo = Schema.Struct({
  fullName: Schema.String,
  description: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  language: Schema.NullOr(Schema.String),
  summary: Schema.String,
  keywords: Schema.Array(Schema.String),
  kind: Schema.String,
  vector: Float32Vector,
});
export type EnrichedRepo = typeof EnrichedRepo.Type;

const summarySchema = Schema.toStandardJSONSchemaV1(Summarize.RepoSummary)["~standard"].jsonSchema.input({
  target: "draft-07",
});
export const summaryFingerprint = (repo: Summarize.RepoFacts): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        facts: {
          fullName: repo.fullName,
          description: repo.description,
          topics: repo.topics,
          language: repo.language,
          readme: repo.readme,
        },
        system: Summarize.system,
        prompt: Summarize.prompt(repo),
        schema: summarySchema,
      }),
    )
    .digest("hex");

const SummaryEntry = Schema.Struct({ fingerprint: Schema.String, summary: Summarize.RepoSummary });
const Summaries = Schema.Record(Schema.String, Schema.Union([SummaryEntry, Summarize.RepoSummary]));
const Vectors = Schema.Record(Schema.String, Schema.Struct({ text: Schema.String, vector: Float32Vector }));

const summaryConcurrency = 8;
const summaryChunk = 64;
const embedBatchSize = 128;

const slug = (model: string) => model.replaceAll("/", "--");

const cacheFile = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
  path: string,
  schema: S,
) => {
  const codec = Schema.fromJsonString(schema);
  const file = Bun.file(new URL(`./.cache/${path}`, import.meta.url));
  return {
    read: Effect.promise(() => file.exists()).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.promise(() => file.text()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(codec)), Effect.orDie)
          : Effect.undefined,
      ),
    ),
    write: (value: S["Type"]) =>
      Schema.encodeEffect(codec)(value).pipe(
        Effect.orDie,
        Effect.flatMap((text) => Effect.promise(() => Bun.write(file, text))),
      ),
  };
};

export const enrich = Effect.fn("EnrichedCorpus.enrich")(function* (summaryModel: string) {
  const embeddings = yield* Embeddings.Embeddings;
  const corpus = yield* Corpus.loadCorpus;
  const summaryCache = cacheFile(`summaries/${slug(summaryModel)}.json`, Summaries);
  const vectorCache = cacheFile(`vectors/${slug(embeddings.model.id)}.json`, Vectors);

  const cached = (yield* summaryCache.read) ?? {};
  const summaries: Record<string, typeof SummaryEntry.Type> = {};
  for (const repo of corpus) {
    const entry = cached[repo.fullName];
    if (entry && "fingerprint" in entry && entry.fingerprint === summaryFingerprint(repo))
      summaries[repo.fullName] = entry;
  }
  const unsummarized = corpus.filter((repo) => summaries[repo.fullName] === undefined);
  if (unsummarized.length > 0) yield* Console.log(`Summarizing ${unsummarized.length} repos with ${summaryModel}`);
  for (let start = 0; start < unsummarized.length; start += summaryChunk) {
    yield* Effect.forEach(
      unsummarized.slice(start, start + summaryChunk),
      (repo) =>
        Summarize.summarize(repo).pipe(
          Effect.tap((summary) =>
            Effect.sync(() => (summaries[repo.fullName] = { fingerprint: summaryFingerprint(repo), summary })),
          ),
          Effect.catch((error) => Console.log(`  no summary for ${repo.fullName}: ${error.message}`)),
        ),
      { concurrency: summaryConcurrency, discard: true },
    );
    yield* summaryCache.write(summaries);
  }

  const vectors: Record<string, { readonly text: string; readonly vector: ReadonlyArray<number> }> = {
    ...(yield* vectorCache.read),
  };
  const texts = corpus.map((repo) => {
    const summary = summaries[repo.fullName]?.summary ?? { summary: repo.description ?? repo.fullName, keywords: [] };
    return { repo, text: Summarize.embeddingText(repo, summary) };
  });
  const unembedded = texts.filter(({ repo, text }) => vectors[repo.fullName]?.text !== text);
  if (unembedded.length > 0) yield* Console.log(`Embedding ${unembedded.length} repos with ${embeddings.model.id}`);
  for (let start = 0; start < unembedded.length; start += embedBatchSize) {
    const batch = unembedded.slice(start, start + embedBatchSize);
    const result = yield* embeddings.embed(batch.map(({ text }) => text));
    batch.forEach(({ repo, text }, index) => {
      vectors[repo.fullName] = { text, vector: result[index]?.vector ?? [] };
    });
  }
  yield* vectorCache.write(vectors);

  return texts.map(({ repo }): EnrichedRepo => {
    const summary = summaries[repo.fullName]?.summary;
    return {
      fullName: repo.fullName,
      description: repo.description,
      topics: repo.topics,
      language: repo.language,
      summary: summary?.summary ?? repo.description ?? repo.fullName,
      keywords: summary?.keywords ?? [],
      kind: summary?.kind ?? "other",
      vector: vectors[repo.fullName]?.vector ?? [],
    };
  });
});
