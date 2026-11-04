import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { embeddingModel } from "@stargrep/ai/models";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as GitHub from "@stargrep/github/github";
import { BudgetShare, Login } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as EnrichQueue from "../src/repos/enrich-queue.ts";
import * as StarSync from "../src/stars/star-sync.ts";

const decodeModelId = Schema.decodeEffect(EmbeddingModelId);

const writeSpans = [
  "Db.accounts.upsert",
  "Db.accounts.recordStarSync",
  "Db.repos.upsertRefs",
  "Db.stars.upsert",
  "Db.stars.applySnapshot",
];

const spans: Array<Tracer.NativeSpan> = [];
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

const requests = { count: 0 };
const queue = EnrichQueue.layerMemory();

const millis = (nanos: bigint) => Number(nanos / 1_000_000n);

const ended = (name: string) =>
  spans.flatMap((span) =>
    span.name === name && span.status._tag === "Ended" && Exit.isSuccess(span.status.exit) ? [span.status] : [],
  );

const sinceSync = (name: string) => {
  const [start] = ended("StarSync.sync");
  const [first] = ended(name);
  return start === undefined || first === undefined ? "none" : `${millis(first.endTime - start.startTime)}ms`;
};

const layerDb = Layer.unwrap(
  Effect.gen(function* () {
    return Db.layerNodePostgres({
      connectionString: yield* Config.Redacted("DATABASE_URL"),
      embeddingModel: yield* decodeModelId(embeddingModel.id),
    });
  }),
);

const layerCountedFetch = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.tapRequest(client, () => Effect.sync(() => requests.count++)),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const layerGitHub = Layer.unwrap(
  Effect.gen(function* () {
    return GitHub.layer.pipe(
      Layer.provide(
        TokenGate.layerMemory({ token: yield* Config.Redacted("GITHUB_TOKEN"), share: BudgetShare.make(0.5) }),
      ),
      Layer.provide(layerCountedFetch),
      Layer.provide(KeyValueStore.layerMemory),
    );
  }),
);

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
        .pipe(Effect.withTracer(tracer));
      const [syncSpan] = ended("StarSync.sync");
      yield* Console.log(`account: ${input.login}`);
      yield* Console.log(`added: ${report.added}`);
      yield* Console.log(`unchanged: ${report.unchanged}`);
      yield* Console.log(`unstarred: ${report.unstarred}`);
      yield* Console.log(`listed: ${report.listed}`);
      yield* Console.log(
        `enqueued: ${report.enqueued} (${new Set(queue.sent.map((message) => message.repoId)).size} distinct repos)`,
      );
      yield* Console.log(`github requests: ${requests.count}`);
      yield* Console.log(`db writes: ${writeSpans.reduce((total, name) => total + ended(name).length, 0)}`);
      yield* Console.log(`first page fetched: ${sinceSync("GitHub.starPage")} after the sync started`);
      yield* Console.log(`first page written: ${sinceSync("Db.stars.upsert")} after the sync started`);
      yield* Console.log(
        `sync: ${syncSpan === undefined ? "none" : `${millis(syncSpan.endTime - syncSpan.startTime)}ms`}`,
      );
    },
    Effect.tapError((error) => Console.error(`failed: ${error._tag}: ${error.message}`)),
    Effect.provide(
      StarSync.layer.pipe(Layer.provideMerge(layerDb), Layer.provideMerge(layerGitHub), Layer.provide(queue.layer)),
    ),
  ),
);

sync.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
