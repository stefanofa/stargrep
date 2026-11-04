import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as GitHub from "@stargrep/github/github";
import { Login } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as Runtime from "./runtime.ts";

const unchangedLimitMillis = 300;
const localLimitMillis = 300;

const spent = { summary: 0, embed: 0, github: 0 };

type GitHubService = GitHub.GitHub["Service"];

const layerTimed = Layer.mergeAll(
  Layer.effect(
    GitHub.GitHub,
    Effect.map(GitHub.GitHub, (inner) =>
      GitHub.GitHub.of({
        ...inner,
        repoFacts: Effect.fn("bench.repoFacts")(function* (ids: Parameters<GitHubService["repoFacts"]>[0]) {
          const [duration, facts] = yield* Effect.timed(inner.repoFacts(ids));
          spent.github += Duration.toMillis(duration);
          return facts;
        }),
        readme: Effect.fn("bench.readme")(function* (input: Parameters<GitHubService["readme"]>[0]) {
          const [duration, text] = yield* Effect.timed(inner.readme(input));
          spent.github += Duration.toMillis(duration);
          return text;
        }),
      }),
    ),
  ),
  Layer.effect(
    TextGeneration.TextGeneration,
    Effect.map(TextGeneration.TextGeneration, (inner) =>
      TextGeneration.TextGeneration.of({
        ...inner,
        generate: Effect.fn("bench.generate")(function* <A>(request: TextGeneration.GenerateRequest<A>) {
          const [duration, value] = yield* Effect.timed(inner.generate(request));
          spent.summary += Duration.toMillis(duration);
          return value;
        }),
      }),
    ),
  ),
  Layer.effect(
    Embeddings.Embeddings,
    Effect.map(Embeddings.Embeddings, (inner) =>
      Embeddings.Embeddings.of({
        ...inner,
        embed: Effect.fn("bench.embed")(function* (values: ReadonlyArray<string>) {
          const [duration, vectors] = yield* Effect.timed(inner.embed(values));
          spent.embed += Duration.toMillis(duration);
          return vectors;
        }),
      }),
    ),
  ),
);

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const stats = (label: string, values: ReadonlyArray<number>) =>
  `${label}: median ${percentile(values, 50).toFixed(0)} ms, p95 ${percentile(values, 95).toFixed(0)} ms, max ${Math.max(...values).toFixed(0)} ms`;

const bench = Command.make(
  "bench",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    count: Flag.Int("count").pipe(Flag.withDefault(20)),
    skip: Flag.Int("skip").pipe(Flag.withDescription("Skip the newest N stars"), Flag.withDefault(0)),
  },
  Effect.fn("bench")(
    function* (input) {
      const github = yield* GitHub.GitHub;
      const repos = (yield* Stream.runCollect(
        github.stars(input.login).pipe(Stream.drop(input.skip), Stream.take(input.count)),
      )).map((star) => star.repo);
      yield* Runtime.storeRefs(repos);
      const rows: Array<{
        readonly single: number;
        readonly summary: number;
        readonly embed: number;
        readonly github: number;
        readonly local: number;
        readonly unchanged: number;
      }> = [];
      for (const repo of repos) {
        spent.summary = 0;
        spent.embed = 0;
        spent.github = 0;
        const [single, outcome] = yield* Effect.timed(EnrichRepo.enrichRepo(repo.id));
        const { summary, embed, github } = spent;
        const [unchanged, again] = yield* Effect.timed(EnrichRepo.enrichRepo(repo.id));
        const total = Duration.toMillis(single);
        const row = {
          single: total,
          summary,
          embed,
          github,
          local: total - summary - embed - github,
          unchanged: Duration.toMillis(unchanged),
        };
        rows.push(row);
        yield* Console.log(
          [
            `${repo.owner}/${repo.name}`,
            outcome._tag,
            `single ${row.single.toFixed(0)} ms = summary ${summary.toFixed(0)} + embed ${embed.toFixed(0)} + github ${github.toFixed(0)} + local ${row.local.toFixed(0)}`,
            `${again._tag} ${row.unchanged.toFixed(0)} ms`,
          ].join("\t"),
        );
      }
      const enriched = rows.filter((row) => row.summary > 0);
      for (const [label, values] of [
        ["single enrichment", enriched.map((row) => row.single)],
        ["summary call", enriched.map((row) => row.summary)],
        ["embedding call", enriched.map((row) => row.embed)],
        ["github requests", enriched.map((row) => row.github)],
        ["local work", enriched.map((row) => row.local)],
        ["unchanged run", rows.map((row) => row.unchanged)],
      ] as const) {
        yield* Console.log(stats(label, values));
      }
      const localPass = enriched.every((row) => row.local <= localLimitMillis);
      const unchangedPass = rows.every((row) => row.unchanged <= unchangedLimitMillis);
      yield* Console.log(`rule local work <= ${localLimitMillis} ms per repo: ${localPass ? "pass" : "fail"}`);
      yield* Console.log(`rule unchanged <= ${unchangedLimitMillis} ms: ${unchangedPass ? "pass" : "fail"}`);
      yield* Console.log(yield* Runtime.githubRequests);
    },
    Effect.provide(layerTimed.pipe(Layer.provideMerge(Runtime.layer))),
  ),
);

bench.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
