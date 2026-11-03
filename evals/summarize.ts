import * as BunServices from "@effect/platform-bun/BunServices";
import * as Local from "@stargrep/ai/local";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Corpus from "./corpus.ts";

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summarize.RepoSummary));

const main = Effect.gen(function* () {
  const corpus = yield* Corpus.loadCorpus;
  const textGeneration = yield* TextGeneration.TextGeneration;
  for (const name of Bun.argv.slice(2)) {
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

await Effect.runPromise(main.pipe(Effect.provide(Local.layer.pipe(Layer.provide(BunServices.layer)))));
