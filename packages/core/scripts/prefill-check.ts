import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import { withClient } from "@stargrep/db/local-database";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as IconQueue from "../src/icons/icon-queue.ts";
import * as EnrichQueue from "../src/repos/enrich-queue.ts";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as EnrichRetry from "../src/repos/enrich-retry.ts";
import { RunReportJson } from "./prefill-files.ts";
import * as Runtime from "./runtime.ts";

// Verifies the prefill driver on a throwaway database with the stand-in models: a run SIGKILLed mid-batch, its resume,
// and a rerun, while the real enrichment sweep and the queue consumer's service run every few seconds beside them with
// a stand-in model that records every summary it is asked for. Never point it at a database the product uses.

const ids = Flag.String("ids").pipe(Flag.withDescription("The prefill list to run"));
const killAfter = Flag.Int("kill-after").pipe(
  Flag.withDescription("SIGKILL the first run once this many of its answers are saved"),
  Flag.withDefault(300),
);
const every = Flag.Int("every").pipe(
  Flag.withDescription("Seconds between sweeps, each followed by the consumer"),
  Flag.withDefault(3),
);
const dir = Flag.String("dir").pipe(Flag.withDescription("Where the run reports and the stand-in batches go"));

const tally = (values: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(counts);
};

const Count = Schema.Struct({ count: Schema.Int });
const decodeCount = Schema.decodeUnknownSync(Schema.Array(Count));

const check = Command.make(
  "prefill-check",
  { ids, killAfter, every, dir },
  Effect.fn("prefillCheck")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const url = Redacted.value(yield* Config.Redacted("DATABASE_URL"));
    const sql = <A>(text: string, values: ReadonlyArray<unknown> = []) =>
      withClient(url, async (client) => (await client.query(text, [...values])).rows as Array<A>);
    const batches = `${flags.dir}/batches`;
    yield* fs.makeDirectory(flags.dir, { recursive: true });
    const startedAt = (yield* sql<{ startedAt: string }>(`select now()::text as "startedAt"`))[0]?.startedAt ?? "now";
    const ours = `select id from extraction_batches where created_at >= '${startedAt}'::timestamptz`;

    // Every summary the consumer's model is asked for, by the repo its prompt names.
    const asked: Array<string> = [];
    const sweeps = { runs: 0, sent: 0 };
    const consumer = EnrichRepo.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Fake.layerTextGeneration((prompt) => {
            asked.push(prompt.slice("Repository: ".length, prompt.indexOf("\n")));
            return SummarizeFake.respond(prompt);
          }, "fake/summary"),
          IconQueue.layerMemory().layer,
        ),
      ),
    );
    const sweepAndConsume = Effect.gen(function* () {
      const queue = EnrichQueue.layerMemory();
      yield* EnrichRetry.sweep().pipe(Effect.provide(queue.layer));
      sweeps.runs++;
      sweeps.sent += queue.sent.length;
      if (queue.sent.length === 0) return;
      const enricher = yield* EnrichRepo.EnrichRepo;
      yield* enricher.enrichRepos(queue.sent.map((message) => message.repoId));
    }).pipe(
      Effect.catch((error) => Console.log(`sweep or consumer failed: ${error._tag}`)),
      Effect.provide(consumer),
    );
    const loop = yield* Effect.forkChild(
      sweepAndConsume.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(flags.every)))),
    );

    const prefill = (name: string) =>
      spawner.spawn(
        ChildProcess.make("bun", ["scripts/prefill.ts", "--ids", flags.ids, "--out", `${flags.dir}/${name}.json`], {
          env: { PREFILL_STAND_IN_DIR: batches },
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
    const saved = () =>
      Effect.map(
        sql(`select count(*)::int as count from receipts where batch_id in (${ours})`),
        (rows) => decodeCount(rows)[0]?.count ?? 0,
      );
    const timed = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const start = yield* Clock.currentTimeMillis;
      const value = yield* effect;
      return { value, seconds: ((yield* Clock.currentTimeMillis) - start) / 1000 };
    });

    yield* Console.log("run 1: prefill, killed mid-batch");
    const killed = yield* timed(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* prefill("run-1");
          yield* saved().pipe(
            Effect.repeat({
              schedule: Schedule.spaced(Duration.millis(500)),
              until: (count) => count >= flags.killAfter,
            }),
          );
          yield* handle.kill({ killSignal: "SIGKILL" });
          yield* Effect.ignore(handle.exitCode);
          return "SIGKILL";
        }),
      ),
    );
    const afterKill = yield* sql<{ manifests: number; open: number; held: number; saved: number }>(
      `select count(*)::int as manifests, count(*) filter (where state in ('prepared', 'submitted'))::int as open,
           (select count(*)::int from repos r, extraction_batches b
             where r.id = any(b.repo_ids) and r.enrich_retry_at = b.lease_until and b.id in (${ours})) as held,
           (select count(*)::int from receipts where batch_id in (${ours})) as saved
         from extraction_batches where id in (${ours})`,
    );
    yield* Console.log(`killed with ${killed.value} after ${killed.seconds} s:`, afterKill[0]);
    for (let n = 0; n < 3; n++) yield* sweepAndConsume;

    yield* Console.log("run 2: resume");
    const resumed = yield* timed(Effect.scoped(Effect.flatMap(prefill("run-2"), (handle) => handle.exitCode)));
    yield* Console.log("run 3: rerun of a finished run");
    const rerun = yield* timed(Effect.scoped(Effect.flatMap(prefill("run-3"), (handle) => handle.exitCode)));
    for (let n = 0; n < 2; n++) yield* sweepAndConsume;
    yield* Fiber.interrupt(loop);

    const submissions = yield* Effect.forEach(
      (yield* fs.readDirectory(batches)).filter((name) => name.startsWith("submissions")),
      (name) => Effect.flatMap(fs.readFileString(`${batches}/${name}`), Schema.decodeEffect(Runtime.SubmissionJson)),
    );
    const paidRepos = new Map<string, number>();
    for (const submission of submissions.filter((entry) => !entry.replayed)) {
      const batch = yield* Effect.flatMap(
        fs.readFileString(`${batches}/${submission.key}`),
        Schema.decodeEffect(Runtime.StandInBatchJson),
      );
      for (const repo of batch.repos) paidRepos.set(repo, (paidRepos.get(repo) ?? 0) + 1);
    }
    const manifestRepos = new Set(
      (yield* sql<{ name: string }>(
        `select r.owner || '/' || r.name as name from repos r join extraction_batches b on r.id = any(b.repo_ids)
           where b.id in (${ours})`,
      )).map((row) => row.name),
    );
    const [receipts] = yield* sql<{ receipts: number; repos: number; duplicates: number; states: string }>(
      `select count(*)::int as receipts, count(distinct repo_id)::int as repos,
           (select count(*)::int from (select repo_id from receipts where captured_at >= '${startedAt}'::timestamptz
             group by repo_id, source, input_hash, recipe having count(*) > 1) d) as duplicates,
           (select string_agg(state || ' ' || n, ', ') from (select state, count(*) as n from extraction_batches
             where id in (${ours}) group by state) s) as states
         from receipts where batch_id in (${ours})`,
    );
    const reports = yield* Effect.forEach(["run-2", "run-3"], (name) =>
      Effect.flatMap(fs.readFileString(`${flags.dir}/${name}.json`), Schema.decodeEffect(RunReportJson)),
    );
    const summary = {
      run1: { exit: killed.value, seconds: killed.seconds, afterKill: afterKill[0] },
      run2: { exit: resumed.value, seconds: resumed.seconds, manifests: reports[0]?.manifests },
      run3: {
        exit: rerun.value,
        seconds: rerun.seconds,
        manifests: reports[1]?.manifests,
        outcomes: tally((reports[1]?.outcomes ?? []).map(([, outcome]) => outcome)),
        statements: reports[1]?.statements.reduce((total, [, count]) => total + count, 0),
      },
      submissions: {
        new: submissions.filter((entry) => !entry.replayed).length,
        replayed: submissions.filter((entry) => entry.replayed).length,
        paidItems: [...paidRepos.values()].reduce((total, count) => total + count, 0),
        repaidRepos: [...paidRepos.values()].filter((count) => count > 1).length,
      },
      receipts,
      sweeps,
      consumerPaid: asked.length,
      consumerPaidForManifestItems: asked.filter((name) => manifestRepos.has(name)).length,
    };
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(summary);
    yield* fs.writeFileString(`${flags.dir}/check.json`, json);
    yield* Console.log(json);
  }, Effect.provide(Runtime.layerPrefill())),
).pipe(Command.withDescription("Kill, resume, and rerun a stand-in prefill beside the real sweep and consumer"));

check.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
