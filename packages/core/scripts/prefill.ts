import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Models from "@stargrep/ai/models";
import * as Port from "@stargrep/ai/port";
import * as Summarize from "@stargrep/ai/summarize";
import * as TextGeneration from "@stargrep/ai/text-generation";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Prefill from "../src/repos/prefill.ts";
import { RunReportJson, readRefs } from "./prefill-files.ts";
import * as Runtime from "./runtime.ts";

const ids = Flag.String("ids").pipe(
  Flag.withDescription("The prefill list, one '<id> <owner>/<name>' per line"),
  Flag.optional,
);

const pending = Flag.Int("pending").pipe(
  Flag.withDescription(
    "Instead of a list, ask at most this many of the repos the Worker's sweep would summarize next, the backlog the daily summary cap leaves. It prints how many wait first, so 0 only prints that. Needs --adapter cli and AI_TEXT_PROVIDER=claude-code",
  ),
  Flag.optional,
);

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

const askCurrent = Flag.Boolean("ask-current").pipe(
  Flag.withDescription(
    "Ask repos whose summary is already current under the recipe too, once each. For pilot 2 on a branch of prod only",
  ),
  Flag.withDefault(false),
);

const summaryModel = Flag.String("summary-model").pipe(
  Flag.withDescription(
    `The Gateway model that writes every summary, such as anthropic/claude-sonnet-5.5, to try another model on the same prompt. Every manifest and receipt records it. Defaults to ${Models.summaryModel}, and needs --adapter batch`,
  ),
  Flag.optional,
);

const summaryReasoning = Flag.Literals("summary-reasoning", TextGeneration.Reasoning.literals).pipe(
  Flag.withDescription(
    `How much the summary model may think, to try another level on the same prompt. Each stored request and the report record it. Defaults to ${Summarize.reasoning}, the recipe's level`,
  ),
  Flag.withDefault(Summarize.reasoning),
);

const resendUnknown = Flag.Boolean("resend-unknown").pipe(
  Flag.withDescription(
    "Send a recorded batch's request again when the provider says it does not know the batch. This pays for it again",
  ),
  Flag.withDefault(false),
);

// A start the CLI refuses, before it opens a database or a provider, so the command exits non-zero.
class PrefillRefused extends Schema.TaggedError<PrefillRefused, { readonly brand: unique symbol }>()("PrefillRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `prefill refuses to start: ${this.reason}`;
  }
}

// Where the run's repos come from: a prefill list, or the Worker's backlog. The backlog is what the Worker would pay
// the Gateway for once its cap has room, so a backlog run asks the Claude Code CLI only, never the Gateway past the cap.
type Source = { readonly _tag: "Ids"; readonly path: string } | { readonly _tag: "Pending"; readonly limit: number };

const sourceOf = (flags: {
  readonly ids: Option.Option<string>;
  readonly pending: Option.Option<number>;
  readonly adapter: "batch" | "cli";
  readonly provider: string;
}): Result.Result<Source, string> => {
  if (Option.isSome(flags.ids) && Option.isSome(flags.pending)) return Result.fail("give --ids or --pending, not both");
  if (Option.isSome(flags.ids)) return Result.succeed({ _tag: "Ids", path: flags.ids.value });
  if (Option.isNone(flags.pending)) return Result.fail("give --ids <file> or --pending <count>");
  if (flags.pending.value < 0) return Result.fail("--pending takes a count of 0 or more");
  if (flags.adapter !== "cli" || flags.provider !== "claude-code") {
    return Result.fail(
      "--pending asks the Claude Code CLI, so it needs --adapter cli and AI_TEXT_PROVIDER=claude-code",
    );
  }
  return Result.succeed({ _tag: "Pending", limit: flags.pending.value });
};

// What an operator does about a manifest the driver keeps open.
const remedy = (stuck: Prefill.Stuck) =>
  stuck.reason === "unknown-batch"
    ? `the provider says it does not know batch ${stuck.providerBatchId}. Check it on the Gateway, and rerun with --resend-unknown only if it is gone, which pays for it again`
    : `its request object ${stuck.requestObject} is ${stuck.reason}. Restore it from where this run stored it, then rerun`;

const textProvider = Config.String("AI_TEXT_PROVIDER").pipe(Config.withDefault("gateway"));
const r2Bucket = Config.option(Config.String("PREFILL_R2_BUCKET"));

// A driver that crashed holds the prefill until its heartbeat goes stale, so a rerun waits that long for it.
const waitForOwner = {
  schedule: Schedule.spaced(Duration.seconds(10)),
  times: 9,
  while: (error: Prefill.PrefillAbort) => error._tag === "PrefillBusy",
};

const run = Command.make(
  "prefill",
  { ids, pending, adapter, chunk, concurrency, out, askCurrent, resendUnknown, summaryModel, summaryReasoning },
  Effect.fn("prefill.run")(function* (flags) {
    if (Option.isSome(flags.summaryModel) && flags.adapter !== "batch") {
      return yield* new PrefillRefused({ reason: "--summary-model names a batch model, and --adapter cli has none" });
    }
    const provider = yield* textProvider;
    const source = sourceOf({ ...flags, provider });
    if (Result.isFailure(source)) return yield* new PrefillRefused({ reason: source.failure });
    const store = Runtime.requestStore(flags.adapter, provider, yield* r2Bucket);
    if (Result.isFailure(store)) return yield* new PrefillRefused({ reason: store.failure });
    yield* runPrefill({ ...flags, source: source.success }, store.success).pipe(
      Effect.provide(Runtime.layerPrefill(flags.summaryModel)),
    );
  }),
).pipe(
  Command.withDescription(
    "Summarize every repo in a prefill list, or the Worker's summary backlog, through resumable provider batches. A rerun resumes what a stopped run sent.",
  ),
);

// The repos a run asks about. A backlog run first says how many repos wait, so --pending 0 is a cheap read of it.
const refsOf = Effect.fn("prefill.refsOf")(function* (source: Source) {
  if (source._tag === "Ids") return yield* readRefs(source.path);
  const { waiting, refs } = yield* Prefill.backlog(source.limit);
  yield* Console.log(
    `backlog: ${waiting} repos wait for a summary, asking the ${refs.length} the sweep would send next`,
  );
  return refs;
});

const runPrefill = Effect.fn("prefill.runPrefill")(function* (
  flags: {
    readonly source: Source;
    readonly adapter: "batch" | "cli";
    readonly chunk: number;
    readonly concurrency: number;
    readonly out: Option.Option<string>;
    readonly askCurrent: boolean;
    readonly resendUnknown: boolean;
    readonly summaryReasoning: TextGeneration.Reasoning;
  },
  store: "r2" | "local",
) {
  const refs = yield* refsOf(flags.source);
  if (flags.source._tag === "Pending" && flags.source.limit === 0) return;
  const prefill = yield* Prefill.Prefill;
  const fs = yield* FileSystem.FileSystem;
  const model = (yield* TextGeneration.TextGeneration).model;
  yield* Console.log(
    `prefill: ${refs.length} repos in chunks of ${flags.chunk}, ${flags.concurrency} at once, adapter ${flags.adapter}, requests in ${store}, reasoning ${flags.summaryReasoning}${flags.askCurrent ? ", asking current repos too" : ""}`,
  );
  const started = yield* Clock.currentTimeMillis;
  const progress = Prefill.progress();
  // The report is written however the run ends, so a run stopped mid-batch with Ctrl-C still counts what it did.
  const write = Effect.fn("prefill.writeReport")(function* (finished: boolean) {
    const report = Prefill.reportOf(progress);
    const elapsedMillis = (yield* Clock.currentTimeMillis) - started;
    const counts = new Map<string, number>();
    for (const outcome of report.outcomes.values()) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    const statements = Runtime.statementCounts();
    yield* Console.log(
      `outcomes: ${Prefill.outcomes.flatMap((outcome) => (counts.has(outcome) ? [`${outcome} ${counts.get(outcome)}`] : [])).join(", ")}`,
    );
    yield* Console.log(
      `manifests: resumed ${report.manifests.resumed}, dropped ${report.manifests.dropped}, created ${report.manifests.created}, closed ${report.manifests.closed}, fallbacks ${report.manifests.fallbacks}, stuck ${report.manifests.stuck.length}`,
    );
    yield* Console.log(`retried in a fallback batch: ${report.retried.length}, repaid items: ${report.repaid}`);
    const tokens = yield* Port.tokensSpent(model);
    const saved = counts.get("saved") ?? 0;
    const perSaved = (total: number) => (saved === 0 ? "-" : Math.round(total / saved));
    yield* Console.log(
      `direct calls: input ${tokens.input} (${tokens.cacheRead} read from cache, ${tokens.cacheWrite} written to it), output ${tokens.output} (${tokens.reasoning} thinking), per saved repo input ${perSaved(tokens.input)}, output ${perSaved(tokens.output)}, and thinking ${perSaved(tokens.reasoning)}`,
    );
    for (const stuck of report.manifests.stuck) yield* Console.log(`stuck manifest ${stuck.id}: ${remedy(stuck)}`);
    // Every repo whose facts did not decode is named, since a rerun reads each again.
    const invalid = report.unresolved.filter((entry) => entry.reason === "invalid");
    for (const { id } of invalid) yield* Console.log(`failed: ${id} GitHub sent no facts for it that decode`);
    const rest = report.unresolved.filter((entry) => entry.reason !== "invalid");
    for (const { id, reason } of rest.slice(0, 20)) yield* Console.log(`unresolved: ${id} ${reason}`);
    yield* Console.log(
      `statements: ${statements.reduce((total, [, count]) => total + count, 0)} (${statements.map(([name, count]) => `${name.slice(3)} ${count}`).join(", ")})`,
    );
    yield* Console.log(`elapsed: ${(elapsedMillis / 1000).toFixed(1)} s${finished ? "" : ", stopped before the end"}`);
    if (flags.out._tag === "None") return;
    const json = yield* Schema.encodeEffect(RunReportJson)({
      elapsedMillis,
      finished,
      summaryReasoning: flags.summaryReasoning,
      outcomes: [...report.outcomes],
      unresolved: report.unresolved,
      manifests: report.manifests,
      retriedRepos: report.retried,
      repaid: report.repaid,
      captures: report.captures,
      usage: report.usage,
      directTokens: tokens,
      statements,
    });
    yield* fs.writeFileString(flags.out.value, json);
  }, Effect.orDie);
  yield* prefill
    .run({
      refs,
      adapter: flags.adapter === "batch" ? "gateway-batch" : "claude-code",
      chunk: flags.chunk,
      concurrency: flags.concurrency,
      progress,
      askCurrent: flags.askCurrent,
      resendUnknown: flags.resendUnknown,
      summaryReasoning: flags.summaryReasoning,
    })
    .pipe(
      Effect.tapError((error) =>
        error._tag === "PrefillBusy" ? Console.log("another prefill driver holds this database, waiting") : Effect.void,
      ),
      Effect.retry(waitForOwner),
      Effect.withTracer(Runtime.countingTracer),
      Effect.onExit((exit) => write(exit._tag === "Success")),
    );
});

run.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
