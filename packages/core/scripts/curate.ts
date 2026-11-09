import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Models from "@stargrep/ai/models";
import * as Db from "@stargrep/db";
import { Decision, fold } from "@stargrep/knowledge/decisions";
import { Revision } from "@stargrep/knowledge/ids";
import { labelKey } from "@stargrep/knowledge/label-key";
import { noise, type SeedEntry } from "@stargrep/knowledge/seeds";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Curation from "../src/knowledge/curation.ts";
import * as RepoKnowledge from "../src/knowledge/repo-knowledge.ts";
import * as Runtime from "./runtime.ts";

const layer = Runtime.layerDb(Models.embeddingModel.id);

const decodeBatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Union([Decision, Schema.Array(Decision)])));
const batchOf = (json: string) =>
  Effect.map(decodeBatch(json), (decoded) => (Array.isArray(decoded) ? decoded : [decoded as Decision]));

const Explore = Schema.Struct({
  commit: Schema.String,
  topics: Schema.Array(
    Schema.Struct({
      topic: Schema.String,
      label: Schema.String,
      definition: Schema.String,
      aliases: Schema.Array(Schema.String),
    }),
  ),
});
const decodeExplore = Schema.decodeUnknownEffect(Schema.fromJsonString(Explore));

const explore = Effect.gen(function* () {
  const file = yield* decodeExplore(
    yield* Effect.promise(() => Bun.file(`${import.meta.dir}/../seeds/github-explore.json`).text()),
  );
  return file.topics.map(
    (topic): SeedEntry => ({
      key: topic.topic,
      label: topic.label,
      definition: topic.definition,
      aliases: [topic.topic, ...topic.aliases],
      status: "accepted",
      reason: `GitHub explore topic ${topic.topic} (github/explore ${file.commit.slice(0, 12)}, CC-BY-4.0)`,
    }),
  );
});

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print every decision with the repos it moves as one JSON line"),
  Flag.withDefault(false),
);
const operator = Flag.Boolean("operator").pipe(
  Flag.withDescription("Apply decisions that move more than 1,000 repos"),
  Flag.withDefault(false),
);
const reason = Flag.String("reason").pipe(Flag.withDescription("Why, kept in the log beside the decision"));
const actor = Flag.String("actor").pipe(Flag.withDescription("Who decides"), Flag.withDefault("operator"));

const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const print = (value: unknown) => Effect.flatMap(toJson(value), Console.log);

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timed(effect).pipe(
    Effect.tap(([duration]) => Console.log(`${Math.round(Duration.toMillis(duration))} ms`)),
    Effect.map(([, result]) => result),
  );

const fail = (error: { readonly _tag: string; readonly message: string }) =>
  Console.error(`refused: ${error._tag}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error)));

const preview = Command.make(
  "preview",
  {
    decisions: Argument.String("decisions").pipe(Argument.withDescription("A Decision, or an array of them, as JSON")),
  },
  Effect.fn("curate.preview")(
    function* ({ decisions }) {
      const batch = yield* batchOf(decisions);
      const result = yield* Curation.preview(batch.map((decision) => ({ decision, reason: "preview" })));
      yield* print(result);
    },
    Effect.tapError(fail),
    Effect.provide(layer),
  ),
).pipe(Command.withDescription("Show what decisions would do against the head, writing nothing"));

const decide = Command.make(
  "decide",
  {
    decisions: Argument.String("decisions").pipe(Argument.withDescription("A Decision, or an array of them, as JSON")),
    reason,
    actor,
    operator,
  },
  Effect.fn("curate.decide")(
    function* (input) {
      const db = yield* Db.Db;
      const batch = yield* batchOf(input.decisions);
      const decided = yield* timed(
        Curation.decide({
          decisions: batch.map((decision) => ({ decision, reason: input.reason })),
          expected: yield* db.knowledge.revision,
          actor: input.actor,
          operator: input.operator,
        }),
      );
      yield* print(decided);
    },
    Effect.tapError(fail),
    Effect.provide(layer),
  ),
).pipe(Command.withDescription("Append decisions to the curation log in one transaction"));

const undo = Command.make(
  "undo",
  {
    revision: Argument.Int("revision"),
    cascade: Flag.Boolean("cascade").pipe(
      Flag.withDescription("Also undo every later decision that leans on it, newest first"),
      Flag.withDefault(false),
    ),
    reason,
    actor,
    operator,
  },
  Effect.fn("curate.undo")(
    function* (input) {
      const db = yield* Db.Db;
      const decided = yield* timed(
        Curation.undo({
          revision: Revision.make(input.revision),
          cascade: input.cascade,
          expected: yield* db.knowledge.revision,
          actor: input.actor,
          reason: input.reason,
          operator: input.operator,
        }),
      );
      yield* print(decided);
    },
    Effect.tapError(fail),
    Effect.provide(layer),
  ),
).pipe(Command.withDescription("Take a decision out of the fold, recorded as an Undo"));

const log = Command.make(
  "log",
  { last: Flag.Int("last").pipe(Flag.withDescription("How many of the newest decisions"), Flag.withDefault(20)) },
  Effect.fn("curate.log")(function* ({ last }) {
    const db = yield* Db.Db;
    const state = fold(yield* db.knowledge.decisions).state;
    for (const entry of state.log.slice(-last)) {
      const flags = state.undone.has(entry.revision) ? "undone" : "";
      yield* print({ revision: entry.revision, undone: flags !== "", decision: entry.decision });
    }
  }, Effect.provide(layer)),
).pipe(Command.withDescription("Print the newest decisions in the log"));

const queue = Command.make(
  "queue",
  { limit: Flag.Int("limit").pipe(Flag.withDescription("How many proposals"), Flag.withDefault(20)) },
  Effect.fn("curate.queue")(function* ({ limit }) {
    for (const proposal of yield* Curation.queue({ limit })) yield* print(proposal);
  }, Effect.provide(layer)),
).pipe(Command.withDescription("Print merge proposals ranked by the repos they move, for a judge to decide"));

const seed = Command.make(
  "seed",
  {
    batch: Argument.Literals("batch", ["github-explore", "noise"]),
    apply: Flag.Boolean("apply").pipe(
      Flag.withDescription("Write the decisions. Without it, print the plan and its impact only"),
      Flag.withDefault(false),
    ),
    operator,
    json,
  },
  Effect.fn("curate.seed")(
    function* (input) {
      const noiseKeys = new Set(
        noise.flatMap((entry) => [entry.label, ...entry.aliases]).flatMap((text) => labelKey(text) ?? []),
      );
      const entries = input.batch === "noise" ? noise : yield* explore;
      const plan = yield* Curation.planSeed(entries, input.batch === "noise" ? new Set() : noiseKeys);
      const kinds = new Map<string, number>();
      for (const { decision } of plan.decisions) kinds.set(decision._tag, (kinds.get(decision._tag) ?? 0) + 1);
      const skipped = new Map<string, number>();
      for (const entry of plan.skipped) skipped.set(entry.reason, (skipped.get(entry.reason) ?? 0) + 1);
      yield* Console.log(
        `seed:${input.batch} at revision ${plan.head}: ${entries.length} entries, ${plan.decisions.length} decisions (${[...kinds].map(([kind, count]) => `${kind} ${count}`).join(", ")}), skipped ${[...skipped].map(([why, count]) => `${why} ${count}`).join(", ") || "none"}, keys dropped ${plan.droppedKeys}`,
      );
      if (plan.decisions.length === 0) return;
      const impact = input.apply
        ? yield* timed(Curation.seed({ ...plan, actor: `seed:${input.batch}`, operator: input.operator }))
        : yield* timed(Curation.preview(plan.decisions));
      const moved = impact.moved;
      yield* Console.log(
        `repos moved: ${moved.reduce((total, count) => total + count, 0)} in all, ${moved.filter((count) => count > 0).length} decisions move any, largest ${Math.max(0, ...moved)}`,
      );
      if ("reproject" in impact) yield* Console.log(`repos to project again: ${impact.reproject}`);
      else yield* Console.log(`revision ${impact.revision}, repos marked stale ${impact.invalidated}`);
      if (input.json) {
        for (const [index, { decision }] of plan.decisions.entries()) {
          yield* print({ decision, moved: moved[index] ?? 0 });
        }
      }
    },
    Effect.tapError(fail),
    Effect.provide(layer),
  ),
).pipe(
  Command.withDescription(
    "Plan, preview, or apply a seed batch: github-explore creates or adopts the curated topics, noise rejects tags that say nothing",
  ),
);

const floor = Command.make(
  "floor",
  {},
  Effect.fn("curate.floor")(function* () {
    const { changed } = yield* timed(RepoKnowledge.count());
    yield* Console.log(`count changed ${changed} subjects`);
    const { accepted } = yield* timed(Curation.floor());
    yield* Console.log(`floor accepted ${accepted} subjects`);
  }, Effect.provide(layer)),
).pipe(Command.withDescription("Run the nightly count and the usage floor now"));

Command.make("curate").pipe(
  Command.withSubcommands([preview, decide, undo, log, queue, seed, floor]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
