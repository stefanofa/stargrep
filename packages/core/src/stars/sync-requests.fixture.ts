import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import type { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { Owner } from "@stargrep/github/owner";
import { BudgetShare, type GitHubAccountId, type Login } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import type * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as OwnerLookup from "./owner-lookup.ts";
import type { LoginSyncRequest } from "./star-sync.ts";
import * as SyncQueue from "./sync-queue.ts";
import * as SyncRequests from "./sync-requests.ts";

export const embeddingModel = "test/model" as EmbeddingModelId;
export const memory = TestDatabase.layerMemory({ embeddingModel });
export const start = Date.parse("2026-11-04T12:00:00Z");
export const minute = 60_000;
export const unitMillis = 1_800;

export const at = (millis: number) => DateTime.makeUnsafe(millis);
export const units = (count: number) => Duration.millis(count * unitMillis);

export const user = (login: string, id: number, starredTotal: number): Owner => ({
  account: {
    id: id as GitHubAccountId,
    login: login as Login,
    type: "user",
    name: null,
    avatarUrl: null,
    followers: 1,
    publicRepos: 2,
  },
  starredTotal,
});

export const org = (login: string, id: number): Owner => ({
  account: { ...user(login, id, 0).account, type: "org", followers: null },
  starredTotal: 0,
});

export const octocat = { starredTotal: 42, accountType: "user" } as const;
export const signedUp = { starredTotal: null, accountType: "user" } as const;

export interface Hooks {
  // Runs before each lookup reaches GitHub, so a test can fail a lookup, hold it, or fill the line meanwhile.
  readonly duringLookup?: (db: Db.Db["Service"]) => Effect.Effect<void, OwnerLookup.OwnerLookupFailed>;
  // Runs each claim, so a test can line the claims up.
  readonly claiming?: (claim: Effect.Effect<boolean, DbQueryFailed>) => Effect.Effect<boolean, DbQueryFailed>;
}

// What a test sees of the queue and of GitHub.
export interface Fakes {
  readonly sent: ReadonlyArray<LoginSyncRequest>;
  readonly delays: ReadonlyArray<Duration.Duration>;
  readonly lookups: ReadonlyArray<Login>;
  readonly owners: Map<string, Owner>;
}

export const share = BudgetShare.make(0.5);

interface Options {
  readonly hooks?: Hooks;
  readonly sender?: Layer.Layer<SyncQueue.SyncQueue>;
  readonly share?: BudgetShare;
}

const layerOf = (
  github: ReturnType<typeof OwnerLookup.layerMemory>,
  sender: Layer.Layer<SyncQueue.SyncQueue>,
  options: Options,
) => {
  const hooks: Hooks = options.hooks ?? {};
  const { duringLookup = () => Effect.void, claiming = (claim) => claim } = hooks;
  const lookups = Layer.effect(
    OwnerLookup.OwnerLookup,
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const memory = yield* OwnerLookup.OwnerLookup;
      return OwnerLookup.OwnerLookup.of({
        lookup: Effect.fn("OwnerLookup.lookup")(function* (login: Login) {
          yield* duringLookup(db);
          return yield* memory.lookup(login);
        }),
      });
    }),
  ).pipe(Layer.provide(github.layer));
  const claims = Layer.effect(
    Db.Db,
    Effect.map(Db.Db, (db) =>
      Db.Db.of({
        ...db,
        syncRequests: { ...db.syncRequests, claim: (claim) => claiming(db.syncRequests.claim(claim)) },
      }),
    ),
  );
  return SyncRequests.layer(options.share ?? share).pipe(
    Layer.provide(claims),
    Layer.provide(lookups),
    Layer.provide(sender),
  );
};

const defaultLogins = ["octocat", "swarm", "hubot", "grace", "linus", "ada", "alan"];

// Runs a test body against a fresh admission service on the shared database, with its own queue and GitHub. GitHub
// knows the default logins, each with 42 stars.
export const admitting = Effect.fn("admitting")(function* <A, E>(
  body: (fakes: Fakes) => Effect.Effect<A, E, SyncRequests.SyncRequests | Db.Db | TestDatabase.TestDatabase>,
  options: Options = {},
) {
  const queue = SyncQueue.layerMemory();
  const github = OwnerLookup.layerMemory();
  for (const [index, login] of defaultLogins.entries()) {
    github.owners.set(login, user(login, login === "octocat" ? 583231 : 9000 + index, 42));
  }
  yield* (yield* TestDatabase.TestDatabase).query("truncate github_accounts, sync_requests, rate_lines cascade");
  yield* TestClock.setTime(start);
  const fakes: Fakes = { sent: queue.sent, delays: queue.delays, lookups: github.lookups, owners: github.owners };
  return yield* body(fakes).pipe(Effect.provide(layerOf(github, options.sender ?? queue.layer, options)));
});

export const brokenQueue = Layer.succeed(
  SyncQueue.SyncQueue,
  SyncQueue.SyncQueue.of({
    send: Effect.fn("SyncQueue.send")(function* () {
      return yield* new SyncQueue.SyncQueueFailed({ cause: "down" });
    }),
  }),
);

export const anyone = (caller = "caller-a"): SyncRequests.Requester => ({
  _tag: "anyone",
  caller: Db.CallerKey.make(caller),
});
export const ownerId = UserId.make("user-owner");
export const owner: SyncRequests.Requester = { _tag: "owner", userId: ownerId };
export const memberId = UserId.make("user-member");
export const signedIn = (caller = "caller-a"): SyncRequests.Requester => ({
  _tag: "signed-in",
  userId: memberId,
  caller: Db.CallerKey.make(caller),
});

export const request = (login: string, by: SyncRequests.Requester = anyone()) =>
  SyncRequests.SyncRequests.use((service) => service.request(login as Login, by));
export const status = (login: string) => SyncRequests.SyncRequests.use((service) => service.status(login as Login));
export const row = (login: string) => Db.Db.use((db) => db.syncRequests.get(login as Login));

export const synced = Effect.fn("synced")(function* (login: string, syncedAt: number) {
  const db = yield* Db.Db;
  const accountId = 583231 as GitHubAccountId;
  yield* db.accounts.upsert({
    id: accountId,
    type: "user",
    login: login as Login,
    name: null,
    avatarUrl: null,
    followers: null,
    publicRepos: null,
  });
  yield* db.accounts.recordStarSync({ accountId, at: at(syncedAt) });
});

export const fullSynced = (syncedAt: number) =>
  Db.Db.use((db) => db.stars.applySnapshot({ accountId: 583231 as GitHubAccountId, stars: [], at: at(syncedAt) }));

export const finished = (login: string) =>
  Effect.flatMap(DateTime.now, (now) =>
    Db.Db.use((db) =>
      Effect.flatMap(db.accounts.byLogin(login as Login), (account) =>
        db.accounts.recordStarSync({ accountId: Option.getOrThrow(account).id, at: now }),
      ),
    ),
  );

// A claim another request holds while it reserves and sends its sync.
export const claimInFlight = (login: string) =>
  Effect.flatMap(DateTime.now, (now) =>
    Db.Db.use((db) =>
      db.syncRequests.claim({
        login: login as Login,
        at: now,
        cooldown: Duration.minutes(10),
        overtakesWaiting: false,
        outcome: "claimed",
      }),
    ),
  );

export const markFailed = (login: string, requestedAt: number) =>
  Db.Db.use((db) => db.syncRequests.settle(login as Login, at(requestedAt), "failed"));

// How many units a line holds past now.
export const lineUnits = (line: Db.LineKey = "all") =>
  Effect.flatMap(DateTime.now, (now) =>
    Db.Db.use((db) => db.rateLines.wait(line, now, Duration.zero)).pipe(
      Effect.map((wait) => Duration.toMillis(wait) / unitMillis),
    ),
  );

// A network's line pays out 150 units an hour.
const networkUnitMillis = 24_000;
const networkLine = (caller: string) => Db.callerLine(Db.CallerKey.make(caller));

export const networkUnits = (caller = "caller-a") =>
  Effect.map(lineUnits(networkLine(caller)), (count) => (count * unitMillis) / networkUnitMillis);

export const fillNetwork = (count: number, caller = "caller-a") =>
  Effect.flatMap(DateTime.now, (now) =>
    Db.Db.use((db) => db.rateLines.adjust(networkLine(caller), now, Duration.millis(count * networkUnitMillis))),
  );

export const reserveUnits = (db: Db.Db["Service"], count: number) =>
  Effect.flatMap(DateTime.now, (now) => db.rateLines.adjust("all", now, units(count))).pipe(Effect.orDie);

export const fill = (count: number) => Db.Db.use((db) => reserveUnits(db, count));

export const admitted = (decision: string) =>
  Effect.map(Metric.value(Metric.withAttributes(SyncRequests.admissions, { decision })), (state) => state.count);

export const outcomeOf = (result: Result.Result<SyncRequests.SyncStatus, SyncRequests.SyncRequestError>) =>
  result._tag === "Success" ? result.success.state : result.failure._tag;

// Holds each claim until count of them have arrived, so they race for the row at once.
export const lineUpClaims = (count: number) =>
  Effect.map(Deferred.make<void>(), (arrived): NonNullable<Hooks["claiming"]> => {
    let claims = 0;
    return (claim) =>
      Effect.suspend(() => {
        claims += 1;
        return claims === count ? Deferred.succeed(arrived, undefined) : Effect.void;
      }).pipe(Effect.andThen(Deferred.await(arrived)), Effect.andThen(claim));
  });

// Holds each lookup until the test answers it.
export const holdLookups = Effect.gen(function* () {
  const looking = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<void>();
  const hook: NonNullable<Hooks["duringLookup"]> = () =>
    Deferred.succeed(looking, undefined).pipe(Effect.andThen(Deferred.await(answer)));
  return { looking, answer, hook };
});
