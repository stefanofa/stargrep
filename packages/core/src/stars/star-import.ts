import type { AiError, AiKeyMissing } from "@stargrep/ai/errors";
import * as Db from "@stargrep/db";
import type { EmbeddingModelMismatch } from "@stargrep/db/embedding";
import type { DbQueryFailed } from "@stargrep/db/errors";
import type { GitHubTokenMissing, Unauthorized } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { GitHubAccountId, Login } from "@stargrep/github/schemas";
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
import * as MetadataEmbeddings from "../repos/metadata-embeddings.ts";
import * as StarSync from "./star-sync.ts";

// A driver holds the import while its heartbeat is fresh. A crashed driver's claim goes stale after ownerStale. A driver
// that has not renewed its claim for ownerRenewal stops, before another driver can take the import.
export const ownerHeartbeat = Duration.seconds(15);
export const ownerRenewal = Duration.seconds(45);
export const ownerStale = Duration.minutes(1);

// embedded counts the account's repos this attempt embedded from their metadata.
type Result =
  | {
      readonly _tag: "Imported";
      readonly report: StarSync.SyncReport;
      readonly embedded: number;
      readonly millis: number;
    }
  | { readonly _tag: "AlreadySynced"; readonly embedded: number }
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

// This driver could not renew its claim, as when the database is out of reach, so it stopped before the claim could go
// stale and let another driver read GitHub on the same token.
export class StarImportRenewalFailed extends Schema.TaggedError<
  StarImportRenewalFailed,
  { readonly brand: unique symbol }
>()("StarImportRenewalFailed", {}) {
  override get message(): string {
    return `This star import driver could not renew its claim for ${Duration.toSeconds(ownerRenewal)} seconds, so it stopped before another driver could take the import`;
  }
}

// What stops a run instead of failing one account: a token GitHub refuses, a missing model key, a pending file that
// cannot be written, a database that stays out of reach, or another driver.
export type StarImportAbort =
  | Unauthorized
  | GitHubTokenMissing
  | AiKeyMissing
  | EnrichQueueFailed
  | DbQueryFailed
  | StarImportBusy
  | StarImportOwnershipLost
  | StarImportRenewalFailed;

type AccountError = StarSync.StarSyncError | AiError | EmbeddingModelMismatch;

// A lost connection, a timeout, or a deadlock would fail every account alike, so the same account is tried again.
const passing = (error: AccountError) =>
  error._tag === "DbQueryFailed" && error.reason !== "query" && error.reason !== "constraint";

// From 5 seconds up to 5 minutes, 8 times, so a query the database drops or times out costs a wait, not every account
// left in the list. A database out of reach for ownerRenewal stops the run through the heartbeat first.
const passingRetry = {
  schedule: Schedule.exponential("5 seconds").pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(5)))),
  ),
  times: 8,
  while: passing,
};

const waitForLimit = waitForGitHub<AccountError>("Star import");

const newId = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.provide(SecureRandom.layerWebCrypto),
);

const dedupe = (logins: ReadonlyArray<Login>) => Arr.dedupeWith(logins, (a, b) => a.toLowerCase() === b.toLowerCase());

// Imports the stars of each login in order, one account at a time, with the services it is given: StarSync's layer
// without embedding and a GitHub client on the operator's token for a bulk import. An account is done once the database
// records its star sync time and every repo it stars that waits for a metadata embedding has one. A rerun reads again
// only an account a crash cut short, whose writes are idempotent, and embeds what is left of an account it skips.
export const run = Effect.fn("StarImport.run")(function* (options: ImportOptions) {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const starSync = yield* StarSync.StarSync;

  const embedStarred = Effect.fnUntraced(function* (accountId: GitHubAccountId) {
    const starred = yield* db.stars.list(accountId);
    return yield* MetadataEmbeddings.embedUnmetered(starred.map((star) => star.repoId));
  });

  const account = Effect.fn("StarImport.account")(
    function* (login: Login) {
      const known = yield* db.accounts.byLogin(login);
      if (Option.isSome(known) && known.value.starsSyncedAt !== null)
        return { _tag: "AlreadySynced", embedded: yield* embedStarred(known.value.id) } satisfies Result;
      const found = yield* github.owner(login);
      if (Option.isNone(found)) return { _tag: "Missing" } satisfies Result;
      const stars = found.value.starredTotal;
      if (stars > options.maxStars) return { _tag: "TooManyStars", stars } satisfies Result;
      const started = yield* Clock.currentTimeMillis;
      const report = yield* starSync.syncOwner(found.value, { mode: "incremental" });
      // A shifted read records no sync time, so the account is not done until a read sees the same count at both ends.
      if (report.shifted)
        return { _tag: "Failed", reason: "the star count moved while the list was read" } satisfies Result;
      const embedded = yield* embedStarred(found.value.account.id);
      return {
        _tag: "Imported",
        report,
        embedded,
        millis: (yield* Clock.currentTimeMillis) - started,
      } satisfies Result;
    },
    Effect.retry(waitForLimit),
    Effect.retry(passingRetry),
  );

  const settle = (error: AccountError): Effect.Effect<Result, StarImportAbort> => {
    switch (error._tag) {
      case "Unauthorized":
      case "GitHubTokenMissing":
      case "AiKeyMissing":
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

  // The driver holds the import for the whole run, so two drivers never read accounts on one token at once. It renews
  // its claim every ownerHeartbeat, and a renewal that cannot reach the database is tried again at the next tick. It
  // counts ownerRenewal from the moment it sent the last renewal that held, which the database stamped no earlier, so
  // it stops while its claim is still fresh on the database's clock.
  const owner = yield* newId;
  const claimedAt = yield* Clock.currentTimeMillis;
  if (!(yield* db.starImports.claim({ owner, stale: ownerStale }))) return yield* new StarImportBusy();
  const heartbeat = Effect.gen(function* () {
    let renewedAt = claimedAt;
    while (true) {
      const deadline = renewedAt + Duration.toMillis(ownerRenewal);
      const wait = Math.min(Duration.toMillis(ownerHeartbeat), deadline - (yield* Clock.currentTimeMillis));
      yield* Effect.sleep(Duration.millis(Math.max(wait, 0)));
      const sentAt = yield* Clock.currentTimeMillis;
      if (sentAt >= deadline) return yield* new StarImportRenewalFailed();
      const held = yield* db.starImports.heartbeat(owner).pipe(
        Effect.timeoutOption(Duration.millis(deadline - sentAt)),
        Effect.catchTags({
          DbQueryFailed: (error) =>
            Effect.logWarning("Star import heartbeat failed, trying again", { error: error.reason }).pipe(
              Effect.as(Option.none<boolean>()),
            ),
        }),
      );
      if (Option.isNone(held)) continue;
      if (!held.value) return yield* new StarImportOwnershipLost();
      renewedAt = sentAt;
    }
  });
  return yield* Effect.raceFirst(work, heartbeat).pipe(Effect.ensuring(Effect.ignore(db.starImports.release(owner))));
});
