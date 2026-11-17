import { expect } from "bun:test";
import * as Embeddings from "@stargrep/ai/embeddings";
import { type AiError, AiKeyMissing, AiUnavailable } from "@stargrep/ai/errors";
import * as AiFake from "@stargrep/ai/fake";
import * as Db from "@stargrep/db";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type * as GitHub from "@stargrep/github/github";
import * as Fake from "@stargrep/github/github.fixture";
import type { Login } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as RateLine from "../limits/rate-line.ts";
import * as EnrichQueue from "../repos/enrich-queue.ts";
import * as StarImport from "./star-import.ts";
import * as StarSync from "./star-sync.ts";

const embeddingModel = "test/model" as EmbeddingModelId;
const syncTime = Date.parse("2026-11-04T00:00:00Z");
const minute = 60_000;
const other = "00000000-0000-4000-8000-000000000b0b";

const fixture = () => {
  const users = new Map<string, { readonly id: number; readonly stars: number }>();
  const hooks: {
    reply: (login: string, page: number) => Fake.Reply | undefined;
    embed: () => Effect.Effect<void, AiError>;
  } = { reply: () => undefined, embed: () => Effect.void };
  const queue = EnrichQueue.layerMemory();
  const embedded: Array<string> = [];

  const starsOf = (login: string) =>
    Array.from({ length: users.get(login)?.stars ?? 0 }, (_, i) => ({
      repo: (users.get(login)?.id ?? 0) * 1_000 + i + 1,
      starredAt: DateTime.formatIso(DateTime.makeUnsafe(syncTime - (i + 1) * minute)),
      description: `Repo ${i + 1}`,
    }));

  const github = Fake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const login: string = JSON.parse(sent.body ?? "{}").variables.login;
      const user = users.get(login);
      const reply = hooks.reply(login, 0);
      if (reply !== undefined) return reply;
      return Fake.ownerReply({
        data: {
          repositoryOwner:
            user === undefined
              ? null
              : {
                  __typename: "User",
                  databaseId: user.id,
                  login,
                  name: null,
                  avatarUrl: null,
                  followers: { totalCount: 1 },
                  repositories: { totalCount: 1 },
                  starredRepositories: { totalCount: user.stars },
                },
        },
      });
    }
    const [, , login = ""] = sent.url.pathname.split("/");
    return hooks.reply(login, Number(sent.url.searchParams.get("page"))) ?? Fake.starPage(starsOf(login), sent);
  });

  const embeddings = Layer.succeed(
    Embeddings.Embeddings,
    Embeddings.make({
      provider: "test",
      model: { ...AiFake.hashEmbeddingModel, id: embeddingModel },
      timeout: Duration.seconds(30),
      run: (values) =>
        Effect.andThen(
          Effect.suspend(() => hooks.embed()),
          Effect.sync(() => {
            embedded.push(...values);
            return {
              vectors: values.map(() => Array.from({ length: 1024 }, (_, at) => (at === 0 ? 1 : 0))),
              tokens: 1,
            };
          }),
        ),
    }),
  );

  const layerOn = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
    StarSync.layerWithoutEmbedding.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(github.layer),
      Layer.provide(queue.layer),
      Layer.provideMerge(embeddings),
    );

  const query = (text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.flatMap(TestDatabase.TestDatabase, (database) => database.query(text, values));

  const reset = Effect.gen(function* () {
    users.clear();
    hooks.reply = () => undefined;
    hooks.embed = () => Effect.void;
    queue.sent.length = 0;
    embedded.length = 0;
    github.sent.length = 0;
    yield* query("truncate github_accounts, repos, stars, star_import_owner, rate_lines cascade");
    yield* TestClock.setTime(syncTime);
  });

  const outcomes: Array<StarImport.Outcome> = [];
  const importStars = (logins: ReadonlyArray<string>, maxStars = 1_000) =>
    Effect.suspend(() => {
      outcomes.length = 0;
      return StarImport.run({
        logins: logins as ReadonlyArray<Login>,
        maxStars,
        retries: 3,
        onOutcome: (outcome) => Effect.sync(() => outcomes.push(outcome)),
      });
    });

  const tags = () =>
    outcomes.map((outcome) =>
      outcome._tag === "Failed" ? `${outcome.login} Failed ${outcome.attempt}` : `${outcome.login} ${outcome._tag}`,
    );

  const stored = (id: number) =>
    query("select count(*)::int as count from stars where account_id = $1 and unstarred_at is null", [id]).pipe(
      Effect.map((rows) => (rows as ReadonlyArray<{ readonly count: number }>)[0]?.count),
    );

  const syncedAt = (id: number) =>
    query("select stars_synced_at from github_accounts where id = $1", [id]).pipe(
      Effect.map((rows) => (rows as ReadonlyArray<{ readonly stars_synced_at: Date | null }>)[0]?.stars_synced_at),
    );

  const metadataEmbedded = () =>
    query("select count(*)::int as count from repos where embedding_source = 'metadata'").pipe(
      Effect.map((rows) => (rows as ReadonlyArray<{ readonly count: number }>)[0]?.count),
    );

  const cases = (test: {
    readonly effect: it.Tester<
      Db.Db | TestDatabase.TestDatabase | StarSync.StarSync | GitHub.GitHub | Embeddings.Embeddings
    >;
  }) => {
    test.effect(
      "imports each login once in order, and skips one too large, one GitHub lacks, and one already done",
      () =>
        Effect.gen(function* () {
          yield* reset;
          users.set("ada", { id: 1, stars: 150 });
          users.set("bob", { id: 2, stars: 3 });
          users.set("grace", { id: 3, stars: 2_000 });
          const logins = ["ada", "bob", "Ada", "grace", "ghost"];

          expect(yield* importStars(logins)).toEqual({ failed: [] });
          expect(tags()).toEqual(["ada Imported", "bob Imported", "grace TooManyStars", "ghost Missing"]);
          expect([yield* stored(1), yield* stored(2), yield* stored(3)]).toEqual([150, 3, 0]);
          expect(outcomes[0]).toMatchObject({ _tag: "Imported", report: { listed: 150, enqueued: 150 } });
          expect(new Set(queue.sent.map((message) => message.repoId)).size).toBe(153);

          github.sent.length = 0;
          yield* importStars(logins);
          expect(tags()).toEqual(["ada AlreadySynced", "bob AlreadySynced", "grace TooManyStars", "ghost Missing"]);
          expect(github.sent.map((sent) => sent.url.pathname)).toEqual(["/graphql", "/graphql"]);
        }),
    );

    test.effect("reads again an account a crash cut short mid-read, and converges on its whole list", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 250 });
        users.set("bob", { id: 2, stars: 5 });
        hooks.reply = (login, page) => (login === "ada" && page === 2 ? { stream: "hang" } : undefined);
        const crashed = yield* Effect.forkChild(importStars(["bob", "ada"]));
        const hung = () =>
          github.sent.some(
            (sent) => sent.url.pathname === "/users/ada/starred" && sent.url.searchParams.get("page") === "2",
          );
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: hung }));
        yield* Fiber.interrupt(crashed);
        expect([yield* stored(1), yield* syncedAt(1)]).toEqual([100, null]);
        yield* query("insert into star_import_owner (owner, heartbeat_at) values ($1, now() - interval '2 minutes')", [
          other,
        ]);

        hooks.reply = () => undefined;
        yield* importStars(["bob", "ada"]);
        expect(tags()).toEqual(["bob AlreadySynced", "ada Imported"]);
        expect(yield* stored(1)).toBe(250);
        expect(yield* syncedAt(1)).not.toBeNull();
        expect(yield* query("select count(*)::int as count from star_import_owner")).toEqual([{ count: 0 }]);
      }),
    );

    test.effect("tries a failed account again after the others, at most three more times", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("flaky", { id: 1, stars: 2 });
        users.set("broken", { id: 2, stars: 2 });
        users.set("fine", { id: 3, stars: 2 });
        let flakyFailures = 2;
        hooks.reply = (login, page) => {
          if (page === 0) return undefined;
          if (login === "broken") return { status: 422, headers: Fake.rateLimitHeaders(4000) };
          if (login === "flaky" && flakyFailures > 0) {
            flakyFailures--;
            return { status: 422, headers: Fake.rateLimitHeaders(4000) };
          }
          return undefined;
        };

        expect(yield* importStars(["flaky", "broken", "fine"])).toEqual({ failed: ["broken" as Login] });
        expect(tags()).toEqual([
          "flaky Failed 1",
          "broken Failed 1",
          "fine Imported",
          "flaky Failed 2",
          "broken Failed 2",
          "flaky Imported",
          "broken Failed 3",
          "broken Failed 4",
        ]);
        expect(outcomes[1]).toEqual(
          expect.objectContaining({
            reason: "GitHubRequestFailed: GitHub 'list-stars' failed on GET /users/broken/starred: status 422",
          }),
        );
        expect(outcomes.find((outcome) => outcome._tag === "Imported" && outcome.login === "flaky")?.attempt).toBe(3);
        expect([yield* stored(1), yield* stored(3)]).toEqual([2, 2]);
      }),
    );

    test.effect("stops the run on a token GitHub refuses, and frees the import", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 2 });
        users.set("bob", { id: 2, stars: 2 });
        hooks.reply = (login) => (login === "bob" ? { status: 401 } : undefined);
        const error = yield* Effect.flip(importStars(["ada", "bob", "ada"]));
        expect(error).toMatchObject({ _tag: "Unauthorized" });
        expect(tags()).toEqual(["ada Imported"]);
        expect(yield* (yield* Db.Db).starImports.claim({ owner: other, stale: StarImport.ownerStale })).toBe(true);
      }),
    );

    test.effect("stops the run when no model key is configured, before it reads another account", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 2 });
        users.set("bob", { id: 2, stars: 2 });
        hooks.embed = () => Effect.fail(new AiKeyMissing({ operation: "embed", model: embeddingModel }));
        expect(yield* Effect.flip(importStars(["ada", "bob"]))).toMatchObject({ _tag: "AiKeyMissing" });
        expect(outcomes).toEqual([]);
        expect(yield* syncedAt(2)).toBeUndefined();
      }),
    );

    test.effect("refuses to start while another driver's heartbeat is fresh, and starts once it goes stale", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 2 });
        yield* (yield* Db.Db).starImports.claim({ owner: other, stale: StarImport.ownerStale });
        expect(yield* Effect.flip(importStars(["ada"]))).toMatchObject({ _tag: "StarImportBusy" });
        expect(github.sent).toEqual([]);

        yield* query("update star_import_owner set heartbeat_at = now() - interval '90 seconds'");
        yield* importStars(["ada"]);
        expect(tags()).toEqual(["ada Imported"]);
      }),
    );

    test.effect("embeds every new repo from its metadata while the Worker's metadata line is spent", () =>
      Effect.gen(function* () {
        yield* reset;
        const db = yield* Db.Db;
        const now = yield* DateTime.now;
        yield* RateLine.reserve(db.rateLines, RateLine.metadataAll, now, RateLine.metadataEmbeddingsPerDay);
        const wait = yield* db.rateLines.wait(RateLine.metadataAll.key, now, Duration.zero);
        users.set("ada", { id: 1, stars: 300 });

        yield* importStars(["ada"]);
        expect(embedded).toHaveLength(300);
        expect(yield* metadataEmbedded()).toBe(300);
        expect(yield* db.rateLines.wait(RateLine.metadataAll.key, now, Duration.zero)).toEqual(wait);
      }),
    );

    test.effect("reads an account again when its star count moves while the list is read", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 3 });
        hooks.reply = (login, page) => {
          if (login === "ada" && page === 1 && users.get("ada")?.stars === 3) users.set("ada", { id: 1, stars: 4 });
          return undefined;
        };

        expect(yield* importStars(["ada"])).toEqual({ failed: [] });
        expect(tags()).toEqual(["ada Failed 1", "ada Imported"]);
        expect(outcomes[0]).toMatchObject({ reason: expect.stringContaining("star count") });
        expect(yield* stored(1)).toBe(4);
        expect(yield* syncedAt(1)).not.toBeNull();
      }),
    );

    test.effect("embeds on a rerun the repos a crash after the sync left without a metadata embedding", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 150 });
        const second = yield* Deferred.make<void>();
        let calls = 0;
        hooks.embed = () =>
          ++calls === 2 ? Effect.andThen(Deferred.succeed(second, undefined), Effect.never) : Effect.void;
        const crashed = yield* Effect.forkChild(importStars(["ada"]));
        yield* Deferred.await(second);
        yield* Fiber.interrupt(crashed);
        expect(yield* syncedAt(1)).not.toBeNull();
        expect(yield* metadataEmbedded()).toBe(128);

        hooks.embed = () => Effect.void;
        expect(yield* importStars(["ada"])).toEqual({ failed: [] });
        expect(yield* metadataEmbedded()).toBe(150);
        expect(outcomes).toEqual([expect.objectContaining({ _tag: "AlreadySynced", embedded: 22 })]);
      }),
    );

    test.effect("tries an account again while its repos' embeddings fail, and a rerun embeds them", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 2 });
        hooks.embed = () =>
          Effect.fail(new AiUnavailable({ operation: "embed", model: embeddingModel, detail: "down" }));

        expect(yield* importStars(["ada"])).toEqual({ failed: ["ada" as Login] });
        expect(tags()).toEqual(["ada Failed 1", "ada Failed 2", "ada Failed 3", "ada Failed 4"]);
        expect(outcomes[0]).toMatchObject({ reason: expect.stringContaining("AiUnavailable") });
        expect([yield* stored(1), yield* metadataEmbedded()]).toEqual([2, 0]);

        hooks.embed = () => Effect.void;
        expect(yield* importStars(["ada"])).toEqual({ failed: [] });
        expect(yield* metadataEmbedded()).toBe(2);
        expect(outcomes).toEqual([expect.objectContaining({ _tag: "AlreadySynced", embedded: 2 })]);
      }),
    );

    test.effect("stops before its claim goes stale when it cannot renew it, and reads GitHub no more", () =>
      Effect.gen(function* () {
        yield* reset;
        users.set("ada", { id: 1, stars: 150 });
        let limited = false;
        hooks.reply = (login, page) => {
          if (login !== "ada" || page !== 2 || limited) return undefined;
          limited = true;
          return { status: 429, headers: { "retry-after": "600" } };
        };
        const db = yield* Db.Db;
        const unreachable = () =>
          Effect.fail(new DbQueryFailed({ operation: "starImports.heartbeat", reason: "transport", sqlState: null }));
        const cutOff = Db.Db.of({
          ...db,
          starImports: { ...db.starImports, heartbeat: unreachable, release: unreachable },
        });
        const secondPages = () =>
          github.sent.filter(
            (sent) => sent.url.pathname === "/users/ada/starred" && sent.url.searchParams.get("page") === "2",
          ).length;

        const running = yield* Effect.forkChild(importStars(["ada"]).pipe(Effect.provideService(Db.Db, cutOff)));
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => limited }));
        yield* TestClock.adjust(Duration.toMillis(StarImport.ownerStale) - 1_000);
        expect(running.pollUnsafe()).toBeDefined();
        yield* TestClock.adjust("10 minutes");
        expect(yield* Effect.flip(Fiber.join(running))).toMatchObject({ _tag: "StarImportRenewalFailed" });
        expect(secondPages()).toBe(1);
      }),
    );
  };

  return { layerOn, cases };
};

for (const [label, database] of [
  ["StarImport on PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["StarImport on Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const) {
  const f = fixture();
  it.layer(f.layerOn(database), { timeout: 30_000 })(label, f.cases);
}
