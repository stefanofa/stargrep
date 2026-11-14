import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { type GitHubError, NotFound } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { type GitHubAccountId, Login, type Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EnrichQueue from "../repos/enrich-queue.ts";
import * as DiffPage from "./diff-page.ts";

export const Mode = Schema.Literals(["incremental", "full"]);
export type Mode = typeof Mode.Type;

// The units admission reserved in githubAll for a sync's own GitHub requests, with the line's receipt for them, so a
// delivery can give back what the line still owes for the units it did not use.
const Reserved = Schema.Struct({
  units: Schema.Int.check(Schema.isGreaterThan(0)),
  endsAt: Schema.DateTimeUtcFromMillis,
  generation: Schema.Int,
  released: Schema.Finite,
});

export const LoginSyncRequest = Schema.Struct({
  login: Login,
  mode: Mode,
  // The debug Worker's queue route and messages queued before triggers recorded a request time carry none.
  requestedAt: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
  // A message without a reservation, such as one from the debug Worker or a signed-in user's, pays for every request
  // the sync makes. A message queued before receipts carries only the units.
  reserved: Schema.optionalKey(Schema.Union([Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), Reserved])),
  // The signed-in user who started the sync. Their token pays for its GitHub reads and for the enrichment it queues.
  userId: Schema.optionalKey(UserId),
});
export type LoginSyncRequest = typeof LoginSyncRequest.Type;

export type SyncReport = DiffPage.SyncReport;

export type StarSyncError =
  | GitHubError
  | DbQueryFailed
  | DbRowInvalid
  | AccountNotFound
  | EnrichQueue.EnrichQueueFailed;

export class StarSync extends Context.Service<
  StarSync,
  {
    readonly syncLogin: (request: LoginSyncRequest) => Effect.Effect<SyncReport, StarSyncError>;
  }
>()("@stargrep/core/stars/star-sync/StarSync") {}

const toStarred = (star: Star): Db.StarredRepo => ({ repoId: star.repo.id, starredAt: star.starredAt, source: "api" });

const noChanges: Db.SnapshotChanges = { starred: [], unstarred: [] };

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const queue = yield* EnrichQueue.EnrichQueue;

  const writePage = Effect.fn("StarSync.writePage")(function* (
    accountId: GitHubAccountId,
    at: DateTime.Utc,
    page: DiffPage.PageDiff,
  ) {
    if (!Arr.isReadonlyArrayNonEmpty(page.listed)) return { page: { ...page, starred: [], enqueued: 0 }, pending: [] };
    yield* db.repos.upsertRefs(page.listed.map((star) => star.repo));
    const starred = yield* db.stars.upsert({
      accountId,
      stars: page.fresh.map((star) => ({ ...toStarred(star), observedAt: at })),
    });
    const pending = yield* db.repos.pendingEnrichment(page.listed.map((star) => star.repo.id));
    return { page: { ...page, starred, enqueued: pending.length }, pending };
  });

  const sync = Effect.fn("StarSync.sync")(function* (
    accountId: GitHubAccountId,
    request: LoginSyncRequest,
    initialCount: number,
  ) {
    const account = yield* db.accounts.require(accountId);
    // The run's start, not its end: the snapshot unstars rows observed before it, and the next run's
    // stop line is this time, so a star added while the pages are read must land after it.
    const at = yield* DateTime.now;
    const stopLine = request.mode === "full" ? Option.none() : Option.fromNullishOr(account.starsSyncedAt);
    const stored = DiffPage.stored(yield* db.stars.list(account.id), stopLine);
    // GitHub pages the list by offset, so a star added or removed mid-read shifts later pages. Equal
    // counts before and after the read are what lets a full read stand as a snapshot.
    const countStars =
      account.type === "org"
        ? Effect.succeed(0)
        : Effect.flatMap(github.owner(account.login), (owner) =>
            Option.match(owner, {
              onNone: () => Effect.fail(new NotFound({ operation: "owner", path: `/users/${account.login}` })),
              onSome: (found) => Effect.succeed(found.starredTotal),
            }),
          );
    const countBefore = Option.isNone(stopLine) ? Option.some(initialCount) : Option.none<number>();

    const written = yield* github.starPages(account.login).pipe(
      Stream.mapAccum(
        () => DiffPage.start,
        (cursor, page) => {
          const [next, diff] = DiffPage.diffPage(stored, cursor, page);
          return [next, [diff]];
        },
      ),
      Stream.takeUntil((page) => page.stopped),
      Stream.mapEffect((page) => writePage(account.id, at, page)),
      Stream.runCollect,
    );
    const pages = written.map(({ page }) => page);
    // Enrichment shares the token gate, so repos enqueued mid-read would hold it between pages.
    const pending = written.flatMap((entry) => entry.pending);
    if (Arr.isReadonlyArrayNonEmpty(pending)) {
      const paidBy = request.userId === undefined ? {} : { userId: request.userId };
      yield* queue.send(pending.map((repoId) => ({ repoId, ...paidBy })));
    }

    const snapshotReady = !pages.some((page) => page.stopped) && Option.isSome(countBefore);
    const countAfter = snapshotReady ? Option.some(yield* countStars) : Option.none<number>();
    const shifted = Option.isSome(countAfter) && Option.isSome(countBefore) && countBefore.value !== countAfter.value;
    const counted = Option.orElse(countAfter, () => countBefore);
    if (Option.isSome(counted)) {
      yield* db.accounts.setStarredCount({ accountId: account.id, starredCount: counted.value });
    }
    const snapshot =
      snapshotReady && !shifted
        ? yield* db.stars.applySnapshot({
            accountId: account.id,
            stars: pages.flatMap((page) => page.listed).map(toStarred),
            at,
          })
        : noChanges;
    if (!shifted) yield* db.accounts.recordStarSync({ accountId: account.id, at });
    return DiffPage.report(stored, pages, snapshot, shifted);
  });

  const syncLogin = Effect.fn("StarSync.syncLogin")(function* (request: LoginSyncRequest) {
    const found = yield* github.owner(request.login);
    if (Option.isNone(found)) return yield* new NotFound({ operation: "owner", path: `/users/${request.login}` });
    const { account, starredTotal } = found.value;
    yield* db.accounts.upsert(account);
    return yield* sync(account.id, request, starredTotal);
  });

  return StarSync.of({ syncLogin });
});

export const layer = Layer.effect(StarSync, make);
