import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as GitHub from "@stargrep/github/github";
import { Login } from "@stargrep/github/schemas";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as Runtime from "./runtime.ts";

const describe = (name: string, outcome: EnrichRepo.Enrichment, dimensions: number) => {
  switch (outcome._tag) {
    case "Summarized":
    case "Embedded":
      return [
        `${name}: ${outcome._tag === "Summarized" ? "summarized" : "embedded again"}`,
        `  summary: ${outcome.summary.summary}`,
        `  kind: ${outcome.summary.kind ?? "none"}`,
        `  keywords: ${outcome.summary.keywords.join(", ")}`,
        `  embedding: ${dimensions} dimensions`,
      ].join("\n");
    case "Failed":
      return `${name}: failed with ${outcome.error._tag}: ${outcome.error.message}`;
    case "Unchanged":
      return `${name}: unchanged`;
    case "Gone":
      return `${name}: gone from GitHub`;
    case "NotFound":
      return `${name}: not stored, run star sync first`;
    case "NoNodeId":
      return `${name}: no stored node id, run star sync first`;
    case "Stale":
      return `${name}: README changed while enriching, left for the next run`;
  }
};

const report = <A, E, R>(run: Effect.Effect<A, E & { readonly _tag: string; readonly message: string }, R>) =>
  Effect.gen(function* () {
    const embeddings = yield* Embeddings.Embeddings;
    yield* Console.log(`embedding model: ${embeddings.model.id}`);
    return yield* run;
  }).pipe(
    Effect.tapError((error) => Console.log(`failed: ${error._tag}: ${error.message}`)),
    Effect.ensuring(
      Effect.suspend(() => Console.log(`github requests: ${Runtime.requests.count}; ${Runtime.requestSummary()}`)),
    ),
  );

const repo = Command.make(
  "repo",
  { fullName: Argument.String("owner/repo") },
  Effect.fn("enrich.repo")(
    function* ({ fullName }) {
      const [resolved, enricher, embeddings] = yield* Effect.all([
        Runtime.resolveRepo(fullName),
        EnrichRepo.EnrichRepo,
        Embeddings.Embeddings,
      ]);
      yield* Runtime.storeRefs([resolved]);
      const started = yield* Clock.currentTimeMillis;
      const outcome = yield* enricher.enrichRepo(resolved.id);
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Console.log(describe(`${resolved.owner}/${resolved.name}`, outcome, embeddings.model.dimensions));
      yield* Console.log(`  enrichment: ${elapsed} ms`);
    },
    report,
    Effect.provide(Runtime.layerEnrich),
  ),
).pipe(Command.withDescription("Enrich one repo, such as effect-ts/effect"));

const stars = Command.make(
  "stars",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("How many of the newest stars to enrich"),
      Flag.withDefault(200),
    ),
  },
  Effect.fn("enrich.stars")(
    function* ({ login, limit }) {
      const [github, enricher, embeddings] = yield* Effect.all([
        GitHub.GitHub,
        EnrichRepo.EnrichRepo,
        Embeddings.Embeddings,
      ]);
      const repos = (yield* Stream.runCollect(github.stars(login).pipe(Stream.take(limit)))).map((star) => star.repo);
      yield* Console.log(`batch: ${repos.length} starred repos of ${login}`);
      const names = new Map<number, string>(repos.map((entry) => [entry.id, `${entry.owner}/${entry.name}`]));
      const ids = yield* Runtime.storeRefs(repos);
      const started = yield* Clock.currentTimeMillis;
      const outcomes = yield* enricher.enrichRepos(ids, "batch");
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      const counts = new Map<string, number>();
      for (const outcome of outcomes) {
        counts.set(outcome._tag, (counts.get(outcome._tag) ?? 0) + 1);
        if (outcome._tag === "Failed") {
          yield* Console.log(
            describe(names.get(outcome.id) ?? String(outcome.id), outcome, embeddings.model.dimensions),
          );
        }
      }
      yield* Console.log(`outcomes: ${[...counts].map(([tag, count]) => `${tag} ${count}`).join(", ")}`);
      yield* Console.log(`batch enrichment: ${elapsed} ms`);
    },
    report,
    Effect.provide(Runtime.layerEnrich),
  ),
).pipe(
  Command.withDescription("Batch-enrich an account's newest stars through one AI Gateway batch job per 250 repos"),
);

Command.make("enrich").pipe(
  Command.withSubcommands([repo, stars]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
