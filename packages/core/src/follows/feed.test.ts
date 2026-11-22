import { describe, expect, test } from "bun:test";
import type * as Db from "@stargrep/db";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Feed from "./feed.ts";

const now = DateTime.makeUnsafe("2026-11-22T12:00:00Z");
const daysAgo = (days: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(now) - days * 86_400_000);

const star = (followee: number, repo: number, days: number, mine = false): Db.FeedStar => ({
  followee: followee as GitHubAccountId,
  repoId: repo as RepoId,
  starredAt: daysAgo(days),
  mine,
});

const shape = (feed: Feed.Feed) =>
  feed.rows.map((row) => ({
    repo: row.repoId as number,
    by: row.starredBy.map((starrer): number => starrer.followee),
  }));

describe("assemble", () => {
  test("one row per repo, the newest star first, each row's starrers newest first", () => {
    const feed = Feed.assemble([star(1, 10, 3), star(2, 10, 1), star(3, 11, 2), star(1, 12, 20)], now);
    expect(shape(feed)).toEqual([
      { repo: 10, by: [2, 1] },
      { repo: 11, by: [3] },
      { repo: 12, by: [1] },
    ]);
  });

  test("hides every repo the follower stars", () => {
    const feed = Feed.assemble([star(1, 10, 1, true), star(2, 10, 2, true), star(1, 11, 3)], now);
    expect(shape(feed)).toEqual([{ repo: 11, by: [1] }]);
  });

  test("lists at most maxRepos repos", () => {
    const stars = Array.from({ length: Feed.maxRepos + 5 }, (_, index) => star(1, 100 + index, index / 10));
    const feed = Feed.assemble(stars, now);
    expect(feed.rows.length).toBe(Feed.maxRepos);
    expect(feed.rows[0]?.repoId).toBe(100 as RepoId);
  });

  test("the top repo is the one the most followees starred within the week, and needs two of them", () => {
    expect(Feed.assemble([star(1, 10, 1), star(2, 11, 2)], now).top).toEqual(Option.none());
    const feed = Feed.assemble(
      [star(1, 10, 1), star(2, 10, 2), star(1, 11, 1), star(2, 11, 3), star(3, 11, 6), star(4, 11, 10)],
      now,
    );
    expect(feed.top).toEqual(Option.some({ repoId: 11 as RepoId, starrers: 3 }));
  });

  test("a top repo the follower stars is hidden with its row", () => {
    const feed = Feed.assemble([star(1, 10, 1, true), star(2, 10, 2, true), star(3, 11, 1)], now);
    expect(feed.top).toEqual(Option.none());
  });

  test("the busiest count every star within the week, the follower's repos included", () => {
    const feed = Feed.assemble(
      [
        star(1, 10, 1),
        star(1, 11, 2, true),
        star(2, 12, 0.5),
        star(3, 13, 3),
        star(3, 14, 4),
        star(3, 15, 5),
        star(4, 16, 9),
      ],
      now,
    );
    expect(feed.busiest.map(({ followee, stars }) => [followee, stars])).toEqual([
      [3, 3],
      [1, 2],
      [2, 1],
    ]);
    expect(DateTime.formatIso(feed.busiest[1]?.latestAt ?? now)).toBe(DateTime.formatIso(daysAgo(1)));
  });
});
