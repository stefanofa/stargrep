import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as GitHub from "@stargrep/github/github";
import { Login } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as Runtime from "./runtime.ts";

const limitMillis = 300;

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const stats = (label: string, values: ReadonlyArray<number>) =>
  `${label}: median ${percentile(values, 50).toFixed(0)} ms, p95 ${percentile(values, 95).toFixed(0)} ms, max ${Math.max(...values).toFixed(0)} ms`;

const timedRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    Runtime.spans.splice(0);
    return Effect.timed(effect.pipe(Effect.withTracer(Runtime.tracer)));
  }).pipe(Effect.map(([duration, value]) => [Duration.toMillis(duration), value] as const));

const bench = Command.make(
  "bench",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    count: Flag.Int("count").pipe(Flag.withDefault(20)),
    skip: Flag.Int("skip").pipe(Flag.withDescription("Skip the newest N stars"), Flag.withDefault(0)),
  },
  Effect.fn("bench")(function* (input) {
    const github = yield* GitHub.GitHub;
    const enricher = yield* EnrichRepo.EnrichRepo;
    const repos = (yield* Stream.runCollect(
      github.stars(input.login).pipe(Stream.drop(input.skip), Stream.take(input.count)),
    )).map((star) => star.repo);
    yield* Runtime.storeRefs(repos);
    const rows: Array<{ readonly single: number; readonly local: number; readonly unchanged: number }> = [];
    for (const repo of repos) {
      const [single, outcomes] = yield* timedRun(enricher.enrichRepos([repo.id]));
      const summary = Runtime.spentMillis("TextGeneration.generate");
      const embed = Runtime.spentMillis("Embeddings.embed");
      const facts = Runtime.spentMillis("GitHub.repoFacts") + Runtime.spentMillis("GitHub.readme");
      const local = single - summary - embed - facts;
      const [unchanged, again] = yield* timedRun(enricher.enrichRepos([repo.id]));
      rows.push({ single, local, unchanged });
      yield* Console.log(
        [
          `${repo.owner}/${repo.name}`,
          outcomes.map((outcome) => outcome._tag).join(", "),
          `single ${single.toFixed(0)} ms = summary ${summary} + embed ${embed} + github ${facts} + local ${local.toFixed(0)}`,
          `${again.map((outcome) => outcome._tag).join(", ")} ${unchanged.toFixed(0)} ms`,
        ].join("\t"),
      );
    }
    yield* Console.log(
      stats(
        "single enrichment",
        rows.map((row) => row.single),
      ),
    );
    yield* Console.log(
      stats(
        "local work",
        rows.map((row) => row.local),
      ),
    );
    yield* Console.log(
      stats(
        "unchanged run",
        rows.map((row) => row.unchanged),
      ),
    );
    const localPass = rows.every((row) => row.local <= limitMillis);
    const unchangedPass = rows.every((row) => row.unchanged <= limitMillis);
    yield* Console.log(`rule local work <= ${limitMillis} ms per repo: ${localPass ? "pass" : "fail"}`);
    yield* Console.log(`rule unchanged <= ${limitMillis} ms: ${unchangedPass ? "pass" : "fail"}`);
    yield* Console.log(`github requests: ${Runtime.requests.count}; ${Runtime.requestSummary()}`);
  }, Effect.provide(Runtime.layerEnrich)),
);

bench.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
