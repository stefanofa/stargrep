import * as Db from "@stargrep/db";
import type { DbQueryFailed } from "@stargrep/db/errors";
import type { GitHubTokenMissing, Unauthorized } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { Login } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { waitForGitHub } from "../limits/github-wait.ts";
import type { EnrichQueueFailed } from "../repos/enrich-queue.ts";
import * as StarSync from "./star-sync.ts";

// A driver holds the import while its heartbeat is fresh. A crashed driver's claim goes stale after ownerStale.
export const ownerHeartbeat = Duration.seconds(15);
export const ownerStale = Duration.minutes(1);

type Result =
  | { readonly _tag: "Imported"; readonly report: StarSync.SyncReport; readonly millis: number }
  | { readonly _tag: "AlreadySynced" }
  | { readonly _tag: "TooManyStars"; readonly stars: number }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failed"; readonly reason: string };

// What one attempt at one login came to, counting from 1. A failed attempt is tried again at the end of the run.
export type Outcome = Result & { readonly login: Login; readonly attempt: number };

export interface ImportOptions {
  // In the order to import them. A login listed twice, in any case, is imported once.
  readonly logins: ReadonlyArray<Login>;
  // An account that has starred more repos than this is skipped.
  readonly maxStars: number;
  // How many more times the run tries an account that failed, once it has tried every login.
  readonly retries: number;
  readonly onOutcome: (outcome: Outcome) => Effect.Effect<void>;
}

// Another driver holds the import and its heartbeat is fresh.
export class StarImportBusy extends Schema.TaggedError<StarImportBusy, { readonly brand: unique symbol }>()(
  "StarImportBusy",
  {},
) {
  override get message(): string {
    return "Another star import driver is running against this database";
  }
}

// This driver's claim went stale and another took the import, so it stops before it reads another account.
export class StarImportOwnershipLost extends Schema.TaggedError<
  StarImportOwnershipLost,
  { readonly brand: unique symbol }
>()("StarImportOwnershipLost", {}) {
  override get message(): string {
    return "This star import driver lost the import to another driver";
  }
}

// What stops a run instead of failing one account: a token GitHub refuses, a pending file that cannot be written, a
// database that stays out of reach, or another driver.
export type StarImportAbort =
  | Unauthorized
  | GitHubTokenMissing
  | EnrichQueueFailed
  | DbQueryFailed
  | StarImportBusy
  | StarImportOwnershipLost;

// A lost connection, a timeout, or a deadlock would fail every account alike, so the same account is tried again.
const passing = (error: StarSync.StarSyncError) =>
  error._tag === "DbQueryFailed" && error.reason !== "query" && error.reason !== "constraint";

// From 5 seconds up to 5 minutes, 8 times, about a quarter of an hour, so a laptop that sleeps or a database that
// restarts costs a wait, not every account left in the list.
const passingRetry = {
  schedule: Schedule.exponential("5 seconds").pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(5)))),
  ),
  times: 8,
  while: passing,
};

const waitForLimit = waitForGitHub<StarSync.StarSyncError>("Star import");

const newId = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.provide(SecureRandom.layerWebCrypto),
);

const dedupe = (logins: ReadonlyArray<Login>) => Arr.dedupeWith(logins, (a, b) => a.toLowerCase() === b.toLowerCase());

// Imports the stars of each login in order, one account at a time, with the services it is given: StarSync's local
// layer and a GitHub client on the operator's token for a bulk import. An account counts as done once the database
// records its star sync time, so a rerun skips it and reads again only an account a crash cut short, whose writes are
// idempotent.
export const run = Effect.fn("StarImport.run")(function* (options: ImportOptions) {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const starSync = yield* StarSync.StarSync;

  const account = Effect.fn("StarImport.account")(
    function* (login: Login) {
      const known = yield* db.accounts.byLogin(login);
      if (Option.exists(known, (found) => found.starsSyncedAt !== null))
        return { _tag: "AlreadySynced" } satisfies Result;
      const found = yield* github.owner(login);
      if (Option.isNone(found)) return { _tag: "Missing" } satisfies Result;
      const stars = found.value.starredTotal;
      if (stars > options.maxStars) return { _tag: "TooManyStars", stars } satisfies Result;
      const started = yield* Clock.currentTimeMillis;
      const report = yield* starSync.syncOwner(found.value, { mode: "incremental" });
      return { _tag: "Imported", report, millis: (yield* Clock.currentTimeMillis) - started } satisfies Result;
    },
    Effect.retry(waitForLimit),
    Effect.retry(passingRetry),
  );

  const settle = (error: StarSync.StarSyncError): Effect.Effect<Result, StarImportAbort> => {
    switch (error._tag) {
      case "Unauthorized":
      case "GitHubTokenMissing":
      case "EnrichQueueFailed":
        return Effect.fail(error);
      case "DbQueryFailed":
        if (passing(error)) return Effect.fail(error);
    }
    return Effect.succeed({ _tag: "Failed", reason: `${error._tag}: ${error.message}` });
  };

  const work = Effect.gen(function* () {
    let left = dedupe(options.logins);
    for (let attempt = 1; attempt <= 1 + options.retries && left.length > 0; attempt++) {
      const failed: Array<Login> = [];
      for (const login of left) {
        const outcome: Outcome = { ...(yield* account(login).pipe(Effect.catch(settle))), login, attempt };
        yield* options.onOutcome(outcome);
        if (outcome._tag === "Failed") failed.push(login);
      }
      left = failed;
    }
    return { failed: left };
  });

  // The driver holds the import for the whole run, so two drivers never read accounts on one token at once. A heartbeat
  // that cannot reach the database is tried again at the next tick. Only another driver's claim stops the run.
  const owner = yield* newId;
  if (!(yield* db.starImports.claim({ owner, stale: ownerStale }))) return yield* new StarImportBusy();
  const heartbeat = Effect.gen(function* () {
    const held = yield* db.starImports.heartbeat(owner).pipe(
      Effect.catchTags({
        DbQueryFailed: (error) =>
          Effect.logWarning("Star import heartbeat failed, trying again", { error: error.reason }).pipe(
            Effect.as(true),
          ),
      }),
    );
    if (!held) return yield* new StarImportOwnershipLost();
  }).pipe(Effect.delay(ownerHeartbeat), Effect.forever);
  return yield* Effect.raceFirst(work, heartbeat).pipe(Effect.ensuring(Effect.ignore(db.starImports.release(owner))));
});
