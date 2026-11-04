import * as Db from "@stargrep/db";
import type { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { GitHubAccountId, Login, type RepoId, type Star } from "@stargrep/github/schemas";
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

export const LoginSyncRequest = Schema.Struct({ login: Login, mode: Mode });
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

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const queue = yield* EnrichQueue.EnrichQueue;

  const writePage = Effect.fn("StarSync.writePage")(function* (accountId: GitHubAccountId, page: DiffPage.PageDiff) {
    if (!Arr.isReadonlyArrayNonEmpty(page.listed)) return { ...page, enqueued: 0 };
    yield* db.repos.upsertRefs(page.listed.map((star) => star.repo));
    yield* db.stars.upsert({ accountId, stars: page.fresh.map(toStarred) });
    const pending = yield* db.repos.pendingEnrichment(page.listed.map((star) => star.repo.id));
    if (Arr.isReadonlyArrayNonEmpty(pending)) yield* queue.send(pending.map((repoId) => ({ repoId })));
    return { ...page, enqueued: pending.length };
  });

  const sync = Effect.fn("StarSync.sync")(function* (request: SyncRequest) {
    const account = yield* db.accounts.require(request.accountId);
    // The run's start, not its end: the snapshot unstars rows observed before it, and the next run's
    // stop line is this time, so a star added while the pages are read must land after it.
    const at = yield* DateTime.now;
    const stored = DiffPage.stored(
      yield* db.stars.list(account.id),
      request.mode === "full" ? Option.none() : Option.fromNullishOr(account.starsSyncedAt),
    );

    const pages = yield* github.starPages(account.login).pipe(
      Stream.mapAccum(
        (): ReadonlySet<RepoId> => new Set(),
        (seen, page) => {
          const diff = DiffPage.diffPage(stored, seen, page);
          return [new Set([...seen, ...diff.listed.map((star) => star.repo.id)]), [diff]];
        },
      ),
      Stream.takeUntil((page) => page.stopped),
      Stream.mapEffect((page) => writePage(account.id, page)),
      Stream.runCollect,
    );

    const unstarred = pages.some((page) => page.stopped)
      ? 0
      : yield* db.stars.applySnapshot({
          accountId: account.id,
          stars: pages.flatMap((page) => page.listed).map(toStarred),
          at,
        });
    yield* db.accounts.recordStarSync({ accountId: account.id, etag: null, at });
    return DiffPage.report(stored, pages, unstarred);
  });

  const syncLogin = Effect.fn("StarSync.syncLogin")(function* (request: LoginSyncRequest) {
    const account = yield* github.account(request.login);
    yield* db.accounts.upsert(account);
    return yield* sync({ accountId: account.id, mode: request.mode });
  });

  return StarSync.of({ sync, syncLogin });
});

export const layer = Layer.effect(StarSync, make);
