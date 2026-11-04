import * as Db from "@stargrep/db";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "@stargrep/db/errors";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { GitHubAccountId, RepoId, Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DiffStars from "./diff-stars.ts";
import * as EnrichQueue from "./enrich-queue.ts";

export const Mode = Schema.Literals(["incremental", "full"]);
export type Mode = typeof Mode.Type;

export interface SyncRequest {
  readonly accountId: GitHubAccountId;
  readonly mode: Mode;
}

export interface SyncReport {
  readonly listed: number;
  readonly added: number;
  readonly unchanged: number;
  readonly unstarred: number;
  readonly enqueued: number;
}

export type StarSyncError =
  | GitHubError
  | DbQueryFailed
  | DbRowInvalid
  | AccountNotFound
  | EnrichQueue.EnrichQueueFailed;

export class StarSync extends Context.Service<
  StarSync,
  {
    readonly sync: (request: SyncRequest) => Effect.Effect<SyncReport, StarSyncError>;
  }
>()("@stargrep/core/stars/star-sync/StarSync") {}

interface Progress {
  readonly listed: ReadonlyArray<Star>;
  readonly added: number;
  readonly restarred: number;
  readonly enqueued: number;
  readonly stopped: boolean;
}

const started: Progress = { listed: [], added: 0, restarred: 0, enqueued: 0, stopped: false };

const toStarred = (star: Star): Db.StarredRepo => ({ repoId: star.repo.id, starredAt: star.starredAt, source: "api" });

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const queue = yield* EnrichQueue.EnrichQueue;

  const writePage = Effect.fn("StarSync.writePage")(function* (
    accountId: GitHubAccountId,
    listed: Arr.NonEmptyReadonlyArray<Star>,
    fresh: ReadonlyArray<Star>,
  ) {
    yield* db.repos.upsertRefs(listed.map(({ repo }) => ({ id: repo.id, owner: repo.owner, name: repo.name })));
    yield* db.stars.upsert({ accountId, stars: fresh.map(toStarred) });
    const pending = yield* db.repos.pendingEnrichment(listed.map((star) => star.repo.id));
    if (Arr.isReadonlyArrayNonEmpty(pending)) yield* queue.send(pending);
    return pending.length;
  });

  const sync = Effect.fn("StarSync.sync")(function* (request: SyncRequest) {
    const { accountId } = request;
    const account = yield* db.accounts
      .get(accountId)
      .pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(new AccountNotFound({ accountId })), onSome: Effect.succeed }),
        ),
      );
    const at = yield* DateTime.now;
    const stored = DiffStars.stored(
      yield* db.stars.list(accountId),
      request.mode === "full" ? Option.none() : Option.fromNullishOr(account.starsSyncedAt),
    );

    const progress = yield* github.stars(account.login).pipe(
      Stream.chunks,
      Stream.mapAccum(
        (): ReadonlySet<RepoId> => new Set(),
        (seen, page) => {
          const diff = DiffStars.diffPage(stored, seen, page);
          return [new Set([...seen, ...diff.listed.map((star) => star.repo.id)]), [diff]];
        },
      ),
      Stream.takeUntil((diff) => diff.stopped),
      Stream.runFoldEffect(
        () => started,
        (progress, diff) =>
          Effect.map(
            Arr.isReadonlyArrayNonEmpty(diff.listed)
              ? writePage(accountId, diff.listed, diff.fresh)
              : Effect.succeed(0),
            (enqueued): Progress => ({
              listed: [...progress.listed, ...diff.listed],
              added: progress.added + diff.fresh.length,
              restarred: progress.restarred + diff.fresh.filter((star) => stored.starredAt.has(star.repo.id)).length,
              enqueued: progress.enqueued + enqueued,
              stopped: diff.stopped,
            }),
          ),
      ),
    );

    const unstarred = progress.stopped
      ? 0
      : yield* db.stars.applySnapshot({ accountId, stars: progress.listed.map(toStarred), at });
    yield* db.accounts.recordStarSync({ accountId, etag: null, at });

    return {
      listed: progress.listed.length,
      added: progress.added,
      unchanged: stored.starredAt.size - progress.restarred - unstarred,
      unstarred,
      enqueued: progress.enqueued,
    } satisfies SyncReport;
  });

  return StarSync.of({ sync });
});

export const layer = Layer.effect(StarSync, make);
