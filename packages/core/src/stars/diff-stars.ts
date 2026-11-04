import type * as Db from "@stargrep/db";
import type { RepoId, Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface Stored {
  readonly starredAt: ReadonlyMap<RepoId, number>;
  readonly lastCompletedRun: Option.Option<number>;
}

export interface PageDiff {
  readonly listed: ReadonlyArray<Star>;
  readonly fresh: ReadonlyArray<Star>;
  readonly stopped: boolean;
}

export const stored = (stars: ReadonlyArray<Db.Star>, lastCompletedRun: Option.Option<DateTime.Utc>): Stored => ({
  starredAt: new Map(stars.map((star) => [star.repoId, DateTime.toEpochMillis(star.starredAt)])),
  lastCompletedRun: Option.map(lastCompletedRun, DateTime.toEpochMillis),
});

const isStored = (stored: Stored, star: Star) =>
  stored.starredAt.get(star.repo.id) === DateTime.toEpochMillis(star.starredAt);

const sawInLastCompletedRun = (stored: Stored, star: Star) =>
  Option.isSome(stored.lastCompletedRun) &&
  DateTime.toEpochMillis(star.starredAt) <= stored.lastCompletedRun.value &&
  isStored(stored, star);

export const diffPage = (stored: Stored, seen: ReadonlySet<RepoId>, page: ReadonlyArray<Star>): PageDiff => {
  const stop = page.findIndex((star) => sawInLastCompletedRun(stored, star));
  const listed = Arr.dedupeWith(stop === -1 ? page : page.slice(0, stop), (a, b) => a.repo.id === b.repo.id).filter(
    (star) => !seen.has(star.repo.id),
  );
  return { listed, fresh: listed.filter((star) => !isStored(stored, star)), stopped: stop !== -1 };
};
