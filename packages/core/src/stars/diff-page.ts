import type * as Db from "@stargrep/db";
import type { RepoId, Star } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface StoredStar {
  readonly starredAt: number;
  readonly observedAt: number;
}

export interface Stored {
  readonly stars: ReadonlyMap<RepoId, StoredStar>;
  readonly stopLine: Option.Option<number>;
}

export interface Cursor {
  readonly seen: ReadonlySet<RepoId>;
  readonly tie: Option.Option<number>;
}

export interface PageDiff {
  readonly listed: ReadonlyArray<Star>;
  readonly fresh: ReadonlyArray<Star>;
  readonly stopped: boolean;
}

export interface WrittenPage extends PageDiff {
  readonly starred: ReadonlyArray<RepoId>;
  readonly enqueued: number;
}

export interface SyncReport {
  readonly listed: number;
  readonly added: number;
  readonly unchanged: number;
  readonly unstarred: number;
  readonly enqueued: number;
  readonly shifted: boolean;
  readonly partial: boolean;
}

// What the count GitHub gave after a full read says about it. A shifted read saw the count move while it read. A
// partial read listed fewer stars than GitHub counts, because GitHub stopped serving the list before its end.
export interface ReadCheck {
  readonly shifted: boolean;
  readonly partial: boolean;
}

export const start: Cursor = { seen: new Set(), tie: Option.none() };

const millis = (star: Star) => DateTime.toEpochMillis(star.starredAt);

export const stored = (stars: ReadonlyArray<Db.Star>, stopLine: Option.Option<DateTime.Utc>): Stored => ({
  stars: new Map(
    stars.map((star) => [
      star.repoId,
      { starredAt: DateTime.toEpochMillis(star.starredAt), observedAt: DateTime.toEpochMillis(star.observedAt) },
    ]),
  ),
  stopLine: Option.map(stopLine, DateTime.toEpochMillis),
});

const isUnchanged = (stored: Stored, star: Star) => stored.stars.get(star.repo.id)?.starredAt === millis(star);

const sawInLastCompletedRun = (stored: Stored, star: Star) =>
  Option.isSome(stored.stopLine) &&
  isUnchanged(stored, star) &&
  (stored.stars.get(star.repo.id)?.observedAt ?? Number.POSITIVE_INFINITY) <= stored.stopLine.value;

// GitHub orders stars that share a starred_at arbitrarily, so a run stops only at a strictly older star.
export const diffPage = (stored: Stored, cursor: Cursor, page: ReadonlyArray<Star>): readonly [Cursor, PageDiff] => {
  const tie = Option.orElse(cursor.tie, () =>
    Option.map(
      Arr.findFirst(page, (star) => sawInLastCompletedRun(stored, star)),
      millis,
    ),
  );
  const stop = Option.match(tie, { onNone: () => -1, onSome: (at) => page.findIndex((star) => millis(star) < at) });
  const listed = Arr.dedupeWith(stop === -1 ? page : page.slice(0, stop), (a, b) => a.repo.id === b.repo.id).filter(
    (star) => !cursor.seen.has(star.repo.id) && !sawInLastCompletedRun(stored, star),
  );
  return [
    { seen: new Set([...cursor.seen, ...listed.map((star) => star.repo.id)]), tie },
    { listed, fresh: listed.filter((star) => !isUnchanged(stored, star)), stopped: stop !== -1 },
  ];
};

export const report = (
  stored: Stored,
  pages: ReadonlyArray<WrittenPage>,
  snapshot: Db.SnapshotChanges,
  check: ReadCheck,
): SyncReport => {
  const added = new Set([...pages.flatMap((page) => page.starred), ...snapshot.starred]);
  const unstarred = new Set(snapshot.unstarred);
  return {
    listed: pages.reduce((total, page) => total + page.listed.length, 0),
    added: added.size,
    unchanged: [...stored.stars.keys()].filter((id) => !added.has(id) && !unstarred.has(id)).length,
    unstarred: unstarred.size,
    enqueued: pages.reduce((total, page) => total + page.enqueued, 0),
    ...check,
  };
};
