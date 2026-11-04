import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { embeddingModel } from "@stargrep/ai/models";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as GitHub from "@stargrep/github/github";
import { BudgetShare, Login, type RepoId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as EnrichQueue from "../src/stars/enrich-queue.ts";
import * as StarSync from "../src/stars/star-sync.ts";

const counts = { requests: 0, writes: 0 };
const marks: { syncStarted?: number; firstFetched?: number; firstPage?: number } = {};
const enqueued: Array<RepoId> = [];

const layerCountedFetch = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, (response) =>
      Effect.sync(() => counts.requests++).pipe(
        Effect.andThen(response),
        Effect.tap((result) =>
          marks.firstFetched === undefined && result.request.url.endsWith("/starred")
            ? Effect.map(Clock.currentTimeMillis, (now) => {
                marks.firstFetched = now;
              })
            : Effect.void,
        ),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const counted = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => Effect.sync(() => counts.writes++));

const layerCountedDb = Layer.effect(
  Db.Db,
  Effect.map(Db.Db, (db) =>
    Db.Db.of({
      ...db,
      accounts: {
        ...db.accounts,
        upsert: (facts) => counted(db.accounts.upsert(facts)),
        recordStarSync: (sync) => counted(db.accounts.recordStarSync(sync)),
      },
      repos: { ...db.repos, upsertRefs: (refs) => counted(db.repos.upsertRefs(refs)) },
      stars: {
        ...db.stars,
        upsert: (input) =>
          (input.stars.length === 0 ? db.stars.upsert(input) : counted(db.stars.upsert(input))).pipe(
            Effect.tap(() =>
              marks.firstPage === undefined
                ? Effect.map(Clock.currentTimeMillis, (now) => {
                    marks.firstPage = now;
                  })
                : Effect.void,
            ),
          ),
        applySnapshot: (snapshot) => counted(db.stars.applySnapshot(snapshot)),
      },
    }),
  ),
);

const layerDb = Layer.unwrap(
  Effect.gen(function* () {
    const connectionString = yield* Config.Redacted("DATABASE_URL").pipe(
      Config.withDefault(Redacted.make("postgres://stargrep:stargrep@127.0.0.1:54317/stargrep")),
    );
    return layerCountedDb.pipe(
      Layer.provideMerge(
        Db.layerNodePostgres({
          connectionString,
          embeddingModel: yield* Schema.decodeEffect(EmbeddingModelId)(embeddingModel.id),
        }),
      ),
    );
  }),
);

const layerGitHub = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    return GitHub.layer.pipe(
      Layer.provide(TokenGate.layerMemory({ token, share: BudgetShare.make(0.5) })),
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
      const started = yield* Clock.currentTimeMillis;
      const github = yield* GitHub.GitHub;
      const db = yield* Db.Db;
      const account = yield* github.account(input.login);
      yield* db.accounts.upsert({ ...account, ownedRepoStars: null });
      marks.syncStarted = yield* Clock.currentTimeMillis;
      const report = yield* (yield* StarSync.StarSync).sync({
        accountId: account.id,
        mode: input.full ? "full" : "incremental",
      });
      const finished = yield* Clock.currentTimeMillis;
      yield* Console.log(`account: ${account.login} (${account.id})`);
      yield* Console.log(`added: ${report.added}`);
      yield* Console.log(`unchanged: ${report.unchanged}`);
      yield* Console.log(`unstarred: ${report.unstarred}`);
      yield* Console.log(`listed: ${report.listed}`);
      yield* Console.log(`enqueued: ${report.enqueued} (${new Set(enqueued).size} distinct repos)`);
      yield* Console.log(`github requests: ${counts.requests}`);
      yield* Console.log(`db writes: ${counts.writes}`);
      yield* Console.log(
        `first page fetched: ${marks.firstFetched === undefined ? "none" : `${marks.firstFetched - marks.syncStarted}ms after the sync started`}`,
      );
      yield* Console.log(
        `first page written: ${marks.firstPage === undefined ? "none" : `${marks.firstPage - marks.syncStarted}ms after the sync started`}`,
      );
      yield* Console.log(`sync: ${finished - marks.syncStarted}ms`);
      yield* Console.log(`wall: ${finished - started}ms`);
    },
    Effect.tapError((error) => Console.error(`failed: ${error._tag}: ${error.message}`)),
    Effect.provide(
      StarSync.layer.pipe(
        Layer.provideMerge(layerDb),
        Layer.provideMerge(layerGitHub),
        Layer.provide(EnrichQueue.layerMemory(enqueued)),
      ),
    ),
  ),
);

sync.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
