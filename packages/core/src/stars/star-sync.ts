import * as Embeddings from "@stargrep/ai/embeddings";
import * as Analytics from "@stargrep/analytics/analytics";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { AccountNotFound, DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { type GitHubError, NotFound } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type * as Owner from "@stargrep/github/owner";
import { type GitHubAccountId, Login, type Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EnrichQueue from "../repos/enrich-queue.ts";
import * as MetadataEmbeddings from "../repos/metadata-embeddings.ts";
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
  // The network that started a signed-out sync, so analytics names the same network when the sync ends.
  caller: Schema.optionalKey(Db.CallerKey),
});
export type LoginSyncRequest = typeof LoginSyncRequest.Type;

// A sync of an account the caller already looked up.
export type OwnerSyncRequest = Omit<LoginSyncRequest, "login">;

export const actorOf = (request: LoginSyncRequest): Analytics.Actor =>
  request.userId !== undefined
    ? Analytics.Actor.User({ userId: request.userId })
    : request.caller !== undefined
      ? Analytics.Actor.Network({ caller: request.caller })
      : Analytics.Actor.Stargrep();

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
    // Syncs an account its caller already looked up, so the sync spends no second lookup on it.
    readonly syncOwner: (owner: Owner.Owner, request: OwnerSyncRequest) => Effect.Effect<SyncReport, StarSyncError>;
  }
>()("@stargrep/core/stars/star-sync/StarSync") {}

const toStarred = (star: Star): Db.StarredRepo => ({ repoId: star.repo.id, starredAt: star.starredAt, source: "api" });

const noChanges: Db.SnapshotChanges = { starred: [], unstarred: [] };

// How long a sync spends embedding its new repos' metadata. A repo it does not reach waits for enrichment, which embeds
// it from its metadata when the summary cap defers it or its summary fails, and the sweep sends it again if its message
// is lost.
const metadataBudget = Duration.seconds(30);

const make = Effect.fnUntraced(function* (embedsMetadata: boolean) {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const queue = yield* EnrichQueue.EnrichQueue;
  const embeddings = yield* Embeddings.Embeddings;

  const writePage = Effect.fn("StarSync.writePage")(function* (
    accountId: GitHubAccountId,
    at: DateTime.Utc,
    page: DiffPage.PageDiff,
  ) {
    if (!Arr.isReadonlyArrayNonEmpty(page.listed)) return { page: { ...page, starred: [], enqueued: 0 }, pending: [] };
    yield* db.repos.saveListed(page.listed.map((star) => star.repo));
    const starred = yield* db.stars.upsert({
      accountId,
      stars: page.fresh.map((star) => ({ ...toStarred(star), observedAt: at })),
    });
    const pending = yield* db.repos.pendingEnrichment(page.listed.map((star) => star.repo.id));
    return { page: { ...page, starred, enqueued: pending.length }, pending };
  });

  const sync = Effect.fn("StarSync.sync")(function* (
    accountId: GitHubAccountId,
    request: OwnerSyncRequest,
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
    const listed = pages.flatMap((page) => page.listed);
    // Enrichment shares the token gate, so repos enqueued mid-read would hold it between pages.
    const pending = written.flatMap((entry) => entry.pending);
    if (Arr.isReadonlyArrayNonEmpty(pending)) {
      const paidBy = request.userId === undefined ? {} : { userId: request.userId };
      yield* queue.send(pending.map((repoId) => ({ repoId, ...paidBy })));
    }

    const snapshotReady = !pages.some((page) => page.stopped) && Option.isSome(countBefore);
    const countAfter = snapshotReady ? Option.some(yield* countStars) : Option.none<number>();
    const shifted = Option.isSome(countAfter) && Option.isSome(countBefore) && countBefore.value !== countAfter.value;
    // GitHub stops serving a very long list before its end, so such a read can tell nothing about the stars it lacks.
    const partial = Option.isSome(countAfter) && !shifted && listed.length < countAfter.value;
    const counted = Option.orElse(countAfter, () => countBefore);
    if (Option.isSome(counted)) {
      yield* db.accounts.setStarredCount({ accountId: account.id, starredCount: counted.value });
    }
    const snapshot =
      snapshotReady && !shifted
        ? yield* db.stars.applySnapshot({ accountId: account.id, stars: listed.map(toStarred), at, complete: !partial })
        : noChanges;
    if (!shifted) yield* db.accounts.recordStarSync({ accountId: account.id, at });
    // A new repo can wait in the enrichment queue for a long time, so it is embedded from the list's metadata now, newest
    // star first. This runs after the sync's own writes and stops at metadataBudget, so a big import never holds them.
    if (embedsMetadata) {
      yield* MetadataEmbeddings.embed(pending).pipe(
        Effect.timeoutOrElse({
          duration: metadataBudget,
          orElse: () =>
            Effect.logInfo("Metadata embedding reached its budget, the rest wait for enrichment", {
              queued: pending.length,
            }),
        }),
        Effect.provideService(Db.Db, db),
        Effect.provideService(Embeddings.Embeddings, embeddings),
      );
    }
    return DiffPage.report(stored, pages, snapshot, { shifted, partial });
  });

  const syncOwner = Effect.fn("StarSync.syncOwner")(function* (owner: Owner.Owner, request: OwnerSyncRequest) {
    yield* db.accounts.upsert(owner.account);
    return yield* sync(owner.account.id, request, owner.starredTotal);
  });

  const syncLogin = Effect.fn("StarSync.syncLogin")(function* (request: LoginSyncRequest) {
    const found = yield* github.owner(request.login);
    if (Option.isNone(found)) return yield* new NotFound({ operation: "owner", path: `/users/${request.login}` });
    return yield* syncOwner(found.value, request);
  });

  return StarSync.of({ syncLogin, syncOwner });
});

export const layer = Layer.effect(StarSync, make(true));

// A bulk import on a developer's machine embeds an account's repos itself once the sync returns, so a rerun can finish
// the embeddings a crash or a failed call left after the sync recorded its time.
export const layerWithoutEmbedding = Layer.effect(StarSync, make(false));
