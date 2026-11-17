import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Local from "@stargrep/ai/local";
import { embeddingModel } from "@stargrep/ai/models";
import { Login } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EnrichQueue from "../src/repos/enrich-queue.ts";
import * as StarSync from "../src/stars/star-sync.ts";
import * as Runtime from "./runtime.ts";

const writeSpans = [
  "Db.accounts.upsert",
  "Db.accounts.recordStarSync",
  "Db.repos.saveListed",
  "Db.stars.upsert",
  "Db.stars.applySnapshot",
];

const queue = EnrichQueue.layerMemory();

const sinceSync = (name: string) => {
  const [start] = Runtime.ended("StarSync.sync");
  const [first] = Runtime.ended(name);
  return start === undefined || first === undefined ? "none" : `${Runtime.millis(first.endTime - start.startTime)}ms`;
};

const sync = Command.make(
  "sync",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    full: Flag.Boolean("full").pipe(
      Flag.withDescription("Read the whole list and mark stars that are gone"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("sync")(
    function* (input) {
      const report = yield* (yield* StarSync.StarSync)
        .syncLogin({ login: input.login, mode: input.full ? "full" : "incremental" })
        .pipe(Effect.withTracer(Runtime.tracer));
      const [syncSpan] = Runtime.ended("StarSync.sync");
      yield* Console.log(`account: ${input.login}`);
      yield* Console.log(`added: ${report.added}`);
      yield* Console.log(`unchanged: ${report.unchanged}`);
      yield* Console.log(`unstarred: ${report.unstarred}`);
      yield* Console.log(`listed: ${report.listed}`);
      yield* Console.log(`shifted: ${report.shifted}`);
      yield* Console.log(`partial: ${report.partial}`);
      yield* Console.log(
        `enqueued: ${report.enqueued} (${new Set(queue.sent.map((message) => message.repoId)).size} distinct repos)`,
      );
      yield* Console.log(`github requests: ${Runtime.requests.count}`);
      yield* Console.log(`db writes: ${writeSpans.reduce((total, name) => total + Runtime.ended(name).length, 0)}`);
      yield* Console.log(`first page fetched: ${sinceSync("GitHub.starPage")} after the sync started`);
      yield* Console.log(`first page written: ${sinceSync("Db.stars.upsert")} after the sync started`);
      yield* Console.log(
        `sync: ${syncSpan === undefined ? "none" : `${Runtime.millis(syncSpan.endTime - syncSpan.startTime)}ms`}`,
      );
    },
    Effect.tapError((error) => Console.error(`failed: ${error._tag}: ${error.message}`)),
    Effect.provide(
      StarSync.layer.pipe(
        Layer.provideMerge(Runtime.layerDb(embeddingModel.id)),
        Layer.provideMerge(Runtime.layerGitHub),
        Layer.provide(queue.layer),
        Layer.provide(Local.layer),
      ),
    ),
  ),
);

sync.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
