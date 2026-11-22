import type * as Db from "@stargrep/db";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

// How many accounts one person may follow.
export const followCap = 1_000;

// The feed reads this far back, and at most this many of each followee's newest stars, so one busy account cannot
// fill it.
export const window = Duration.days(30);
export const perFollowee = 50;

// How many repos the feed lists, newest star first.
export const maxRepos = 100;

// The top repo and the busiest people count stars from this far back.
export const week = Duration.days(7);

// The top repo needs this many followees who starred it within the week.
export const topStarrers = 2;

export const busiestCount = 3;

export interface Starrer {
  readonly followee: GitHubAccountId;
  readonly starredAt: DateTime.Utc;
}

export interface Row {
  readonly repoId: RepoId;
  // Newest first.
  readonly starredBy: ReadonlyArray<Starrer>;
}

export interface Busy {
  readonly followee: GitHubAccountId;
  readonly stars: number;
  readonly latestAt: DateTime.Utc;
}

export interface Feed {
  // One row per repo the follower doesn't star, the newest star first.
  readonly rows: ReadonlyArray<Row>;
  // The repo the most followees starred within the week, when at least topStarrers did.
  readonly top: Option.Option<{ readonly repoId: RepoId; readonly starrers: number }>;
  // The followees who starred the most within the week, the follower's own repos counted too.
  readonly busiest: ReadonlyArray<Busy>;
}

const newest = (row: Row) => DateTime.toEpochMillis(row.starredBy[0]?.starredAt ?? DateTime.makeUnsafe(0));

const byNewest = (a: Starrer, b: Starrer) =>
  DateTime.toEpochMillis(b.starredAt) - DateTime.toEpochMillis(a.starredAt) || a.followee - b.followee;

// Folds followees' stars into one row per repo, hiding the repos the follower stars, and picks the week's top repo and
// busiest people.
export const assemble = (stars: ReadonlyArray<Db.FeedStar>, now: DateTime.Utc): Feed => {
  const weekStart = DateTime.toEpochMillis(DateTime.subtractDuration(now, week));
  const thisWeek = (star: { readonly starredAt: DateTime.Utc }) => DateTime.toEpochMillis(star.starredAt) >= weekStart;

  const byRepo = new Map<RepoId, Array<Starrer>>();
  const busy = new Map<GitHubAccountId, { stars: number; latestAt: DateTime.Utc }>();
  for (const star of stars) {
    if (thisWeek(star)) {
      const seen = busy.get(star.followee);
      if (seen === undefined) busy.set(star.followee, { stars: 1, latestAt: star.starredAt });
      else {
        seen.stars += 1;
        if (DateTime.isGreaterThan(star.starredAt, seen.latestAt)) seen.latestAt = star.starredAt;
      }
    }
    if (star.mine) continue;
    const starrers = byRepo.get(star.repoId) ?? [];
    starrers.push({ followee: star.followee, starredAt: star.starredAt });
    byRepo.set(star.repoId, starrers);
  }

  const rows = [...byRepo]
    .map(([repoId, starredBy]): Row => ({ repoId, starredBy: starredBy.toSorted(byNewest) }))
    .toSorted((a, b) => newest(b) - newest(a) || a.repoId - b.repoId)
    .slice(0, maxRepos);

  const top = rows.reduce<Option.Option<{ readonly repoId: RepoId; readonly starrers: number }>>((best, row) => {
    const starrers = row.starredBy.filter(thisWeek).length;
    if (starrers < topStarrers) return best;
    return Option.isSome(best) && best.value.starrers >= starrers
      ? best
      : Option.some({ repoId: row.repoId, starrers });
  }, Option.none());

  const busiest = [...busy]
    .map(([followee, { stars, latestAt }]): Busy => ({ followee, stars, latestAt }))
    .toSorted(
      (a, b) =>
        b.stars - a.stars ||
        DateTime.toEpochMillis(b.latestAt) - DateTime.toEpochMillis(a.latestAt) ||
        a.followee - b.followee,
    )
    .slice(0, busiestCount);

  return { rows, top, busiest };
};
