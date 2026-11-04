import * as Db from "@stargrep/db";
import type { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { GitHubAccountId, Login, type Star } from "@stargrep/github/schemas";
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

export const SyncRequest = Schema.Struct({ accountId: GitHubAccountId, mode: Mode });
export type SyncRequest = typeof SyncRequest.Type;

export const LoginSyncRequest = Schema.Struct({
  login: Login,
  mode: Mode,
  // The debug Worker's queue route and messages queued before triggers recorded a request time carry none.
  requestedAt: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
});
export type LoginSyncRequest = typeof LoginSyncRequest.Type;

export type StarSyncError =
  | GitHubError
  | DbQueryFailed
  | DbRowInvalid
  | AccountNotFound
  | EnrichQueue.EnrichQueueFailed;

export class StarSync extends Context.Service<
  StarSync,
  {
    readonly sync: (request: SyncRequest) => Effect.Effect<DiffPage.SyncReport, StarSyncError>;
    readonly syncLogin: (request: LoginSyncRequest) => Effect.Effect<DiffPage.SyncReport, StarSyncError>;
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

  const sync = Effect.fn("StarSync.sync")(function* (request: SyncRequest) {
    const account = yield* db.accounts.require(request.accountId);
    // The run's start, not its end: the snapshot unstars rows observed before it, and the next run's
    // stop line is this time, so a star added while the pages are read must land after it.
    const at = yield* DateTime.now;
    const stopLine = request.mode === "full" ? Option.none() : Option.fromNullishOr(account.starsSyncedAt);
    const stored = DiffPage.stored(yield* db.stars.list(account.id), stopLine);
    // GitHub pages the list by offset, so a star added or removed mid-read shifts later pages. Equal
    // counts before and after the read are what lets a full read stand as a snapshot.
    const countStars = account.type === "org" ? Effect.succeed(0) : github.starCount(account.login);
    const countBefore = Option.isNone(stopLine) ? Option.some(yield* countStars) : Option.none<number>();

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
    if (Arr.isReadonlyArrayNonEmpty(pending)) yield* queue.send(pending.map((repoId) => ({ repoId })));

    const snapshotReady = !pages.some((page) => page.stopped) && Option.isSome(countBefore);
    const shifted = snapshotReady && countBefore.value !== (yield* countStars);
    const snapshot =
      snapshotReady && !shifted
        ? yield* db.stars.applySnapshot({
            accountId: account.id,
            stars: pages.flatMap((page) => page.listed).map(toStarred),
            at,
          })
        : noChanges;
    if (!shifted) yield* db.accounts.recordStarSync({ accountId: account.id, etag: null, at });
    return DiffPage.report(stored, pages, snapshot, shifted);
  });

  const syncLogin = Effect.fn("StarSync.syncLogin")(function* (request: LoginSyncRequest) {
    const account = yield* github.account(request.login);
    yield* db.accounts.upsert(account);
    return yield* sync({ accountId: account.id, mode: request.mode });
  });

  return StarSync.of({ sync, syncLogin });
});

export const layer = Layer.effect(StarSync, make);
