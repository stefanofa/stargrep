import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Port from "@stargrep/ai/port";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Prefill from "../src/repos/prefill.ts";
import { RunReportJson, readRefs } from "./prefill-files.ts";
import * as Runtime from "./runtime.ts";

const ids = Flag.String("ids").pipe(Flag.withDescription("The prefill list, one '<id> <owner>/<name>' per line"));

const adapter = Flag.Literals("adapter", ["batch", "cli"]).pipe(
  Flag.withDescription(
    "batch sends each chunk as one Gateway batch; cli asks the Claude Code CLI one prompt at a time",
  ),
  Flag.withDefault("batch" as const),
);

const chunk = Flag.Int("chunk").pipe(
  Flag.withDescription("Repos per chunk, and so per provider batch, at most 1000"),
  Flag.withDefault(250),
);

const concurrency = Flag.Int("concurrency").pipe(Flag.withDescription("Chunks in flight at once"), Flag.withDefault(4));

const out = Flag.String("out").pipe(
  Flag.withDescription("Where to write the run's report as JSON, for the pilot gates"),
  Flag.optional,
);

const run = Command.make(
  "prefill",
  { ids, adapter, chunk, concurrency, out },
  Effect.fn("prefill.run")(function* (flags) {
    const refs = yield* readRefs(flags.ids);
    const prefill = yield* Prefill.Prefill;
    yield* Console.log(
      `prefill: ${refs.length} repos in chunks of ${flags.chunk}, ${flags.concurrency} at once, adapter ${flags.adapter}`,
    );
    const started = yield* Clock.currentTimeMillis;
    const report = yield* prefill
      .run({
        refs,
        adapter: flags.adapter === "batch" ? "gateway-batch" : "claude-code",
        chunk: flags.chunk,
        concurrency: flags.concurrency,
      })
      .pipe(Effect.withTracer(Runtime.countingTracer));
    const elapsedMillis = (yield* Clock.currentTimeMillis) - started;
    const counts = new Map<string, number>();
    for (const outcome of report.outcomes.values()) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    const statements = Runtime.statementCounts();
    const directTokens = yield* Port.tokensSpent((yield* TextGeneration.TextGeneration).model);
    yield* Console.log(
      `outcomes: ${Prefill.outcomes.flatMap((outcome) => (counts.has(outcome) ? [`${outcome} ${counts.get(outcome)}`] : [])).join(", ")}`,
    );
    yield* Console.log(
      `manifests: resumed ${report.manifests.resumed}, dropped ${report.manifests.dropped}, created ${report.manifests.created}, closed ${report.manifests.closed}`,
    );
    yield* Console.log(`direct calls: ${report.direct.length}, repaid items: ${report.repaid}`);
    for (const { id, reason } of report.unresolved.slice(0, 20)) yield* Console.log(`unresolved: ${id} ${reason}`);
    yield* Console.log(
      `statements: ${statements.reduce((total, [, count]) => total + count, 0)} (${statements.map(([name, count]) => `${name.slice(3)} ${count}`).join(", ")})`,
    );
    yield* Console.log(`elapsed: ${(elapsedMillis / 1000).toFixed(1)} s`);
    if (flags.out._tag === "Some") {
      const fs = yield* FileSystem.FileSystem;
      const json = yield* Schema.encodeEffect(RunReportJson)({
        elapsedMillis,
        outcomes: [...report.outcomes],
        unresolved: report.unresolved,
        manifests: report.manifests,
        directRepos: report.direct,
        repaid: report.repaid,
        captures: report.captures,
        usage: report.usage,
        directTokens,
        statements,
      });
      yield* fs.writeFileString(flags.out.value, json);
    }
  }, Effect.provide(Runtime.layerPrefill)),
).pipe(
  Command.withDescription(
    "Summarize every repo in a prefill list through resumable provider batches. A rerun resumes what a killed run sent.",
  ),
);

run.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
