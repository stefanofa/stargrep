import * as BunServices from "@effect/platform-bun/BunServices";
import * as AiConfig from "@stargrep/ai/config";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const RepoFacts = Schema.Struct({
  fullName: Schema.String,
  description: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  language: Schema.NullOr(Schema.String),
  readme: Schema.NullOr(Schema.String),
});
const decodeCorpus = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RepoFacts)));
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summarize.RepoSummary));

const names = Bun.argv.slice(2);

const main = Effect.gen(function* () {
  const text = yield* Effect.promise(() => Bun.file(new URL("./.cache/corpus.json", import.meta.url)).text());
  const corpus = yield* decodeCorpus(text);
  const textGeneration = yield* TextGeneration.TextGeneration;
  for (const name of names) {
    const repo = corpus.find((entry) => entry.fullName === name);
    if (repo === undefined) {
      yield* Console.log(`${name}: not in evals/.cache/corpus.json`);
      continue;
    }
    const [duration, summary] = yield* Effect.timed(Summarize.summarize(repo));
    yield* Console.log(
      `${name} via ${textGeneration.model} in ${Duration.toMillis(duration).toFixed(0)} ms\n${yield* encodeSummary(summary)}`,
    );
  }
});

await Effect.runPromise(main.pipe(Effect.provide(AiConfig.layer.pipe(Layer.provide(BunServices.layer)))));
