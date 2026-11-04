import type * as Db from "@stargrep/db";
import type { RepoId, Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface Stored {
  readonly starredAt: ReadonlyMap<RepoId, number>;
  readonly stopLine: Option.Option<number>;
}

export interface PageDiff {
  readonly listed: ReadonlyArray<Star>;
  readonly fresh: ReadonlyArray<Star>;
  readonly stopped: boolean;
}

export interface WrittenPage extends PageDiff {
  readonly enqueued: number;
}

export interface SyncReport {
  readonly listed: number;
  readonly added: number;
  readonly unchanged: number;
  readonly unstarred: number;
  readonly enqueued: number;
}

export const stored = (stars: ReadonlyArray<Db.Star>, stopLine: Option.Option<DateTime.Utc>): Stored => ({
  starredAt: new Map(stars.map((star) => [star.repoId, DateTime.toEpochMillis(star.starredAt)])),
  stopLine: Option.map(stopLine, DateTime.toEpochMillis),
});

const isUnchanged = (stored: Stored, star: Star) =>
  stored.starredAt.get(star.repo.id) === DateTime.toEpochMillis(star.starredAt);

const isBehindStopLine = (stored: Stored, star: Star) =>
  Option.isSome(stored.stopLine) &&
  DateTime.toEpochMillis(star.starredAt) <= stored.stopLine.value &&
  isUnchanged(stored, star);

export const diffPage = (stored: Stored, seen: ReadonlySet<RepoId>, page: ReadonlyArray<Star>): PageDiff => {
  const stop = page.findIndex((star) => isBehindStopLine(stored, star));
  const listed = Arr.dedupeWith(stop === -1 ? page : page.slice(0, stop), (a, b) => a.repo.id === b.repo.id).filter(
    (star) => !seen.has(star.repo.id),
  );
  return { listed, fresh: listed.filter((star) => !isUnchanged(stored, star)), stopped: stop !== -1 };
};

export const report = (stored: Stored, pages: ReadonlyArray<WrittenPage>, unstarred: number): SyncReport => {
  const fresh = pages.flatMap((page) => page.fresh);
  const restarred = fresh.filter((star) => stored.starredAt.has(star.repo.id)).length;
  return {
    listed: pages.reduce((total, page) => total + page.listed.length, 0),
    added: fresh.length,
    unchanged: stored.starredAt.size - restarred - unstarred,
    unstarred,
    enqueued: pages.reduce((total, page) => total + page.enqueued, 0),
  };
};
