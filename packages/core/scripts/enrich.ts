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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as Runtime from "./runtime.ts";

const describe = (name: string, outcome: EnrichRepo.Enrichment) => {
  switch (outcome._tag) {
    case "Enriched":
      return [
        `${name}: ${outcome.summarized ? "enriched" : "embedded again"}`,
        `  summary: ${outcome.summary.summary}`,
        `  kind: ${outcome.summary.kind ?? "none"}`,
        `  keywords: ${outcome.summary.keywords.join(", ")}`,
        `  embedding: ${outcome.dimensions} dimensions`,
      ].join("\n");
    case "Failed":
      return `${name}: failed with ${outcome.error._tag}: ${outcome.error.message}`;
    case "Unchanged":
      return `${name}: unchanged`;
    case "Gone":
      return `${name}: gone from GitHub`;
    case "NoNodeId":
      return `${name}: no stored node id, run star sync first`;
    case "Stale":
      return `${name}: README changed while enriching, left for the next run`;
  }
};

const one = Effect.fn("enrich.one")(function* (fullName: string) {
  const repo = yield* Runtime.resolveRepo(fullName);
  yield* Runtime.storeRefs([repo]);
  const started = yield* Clock.currentTimeMillis;
  const outcome = yield* EnrichRepo.enrichRepo(repo.id);
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  yield* Console.log(describe(`${repo.owner}/${repo.name}`, outcome));
  yield* Console.log(`  enrichment: ${elapsed} ms`);
});

const stars = Effect.fn("enrich.stars")(function* (login: Login, limit: number) {
  const github = yield* GitHub.GitHub;
  const repos = (yield* Stream.runCollect(github.stars(login).pipe(Stream.take(limit)))).map((star) => star.repo);
  yield* Console.log(`batch: ${repos.length} starred repos of ${login}`);
  const names = new Map<number, string>(repos.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]));
  const ids = yield* Runtime.storeRefs(repos);
  const started = yield* Clock.currentTimeMillis;
  const outcomes = yield* EnrichRepo.enrichRepos(ids);
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    const key = outcome._tag === "Enriched" && !outcome.summarized ? "Embedded" : outcome._tag;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const outcome of outcomes) {
    if (outcome._tag === "Failed") yield* Console.log(describe(names.get(outcome.id) ?? String(outcome.id), outcome));
  }
  yield* Console.log(`outcomes: ${[...counts].map(([tag, count]) => `${tag} ${count}`).join(", ")}`);
  yield* Console.log(`batch enrichment: ${elapsed} ms`);
});

const enrich = Command.make(
  "enrich",
  {
    repo: Argument.String("owner/repo").pipe(Argument.optional),
    stars: Flag.String("stars").pipe(
      Flag.withDescription("Batch-enrich the newest starred repos of this login"),
      Flag.withSchema(Login),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(Flag.withDescription("How many stars to batch-enrich"), Flag.withDefault(200)),
  },
  Effect.fn("enrich")(function* (input) {
    const embeddings = yield* Embeddings.Embeddings;
    yield* Console.log(`embedding model: ${embeddings.model.id}`);
    const run = Option.isSome(input.stars)
      ? stars(input.stars.value, input.limit)
      : Option.isSome(input.repo)
        ? one(input.repo.value)
        : Console.log("usage: enrich <owner/repo> | enrich --stars <login> [--limit 200]");
    yield* run.pipe(
      Effect.tapError((error) => Console.log(`failed: ${error._tag}: ${error.message}`)),
      Effect.ensuring(Effect.flatMap(Runtime.githubRequests, Console.log)),
    );
  }, Effect.provide(Runtime.layer)),
);

enrich.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
