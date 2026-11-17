import { describe, expect, test } from "bun:test";
import type * as Db from "@stargrep/db";
import type { GitHubAccountId, Login, RepoId, RepoName, RepoNodeId, Star } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as DiffPage from "./diff-page.ts";

const hour = 3_600_000;
const time = (hours: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 1) + hours * hour);

const listed = (repo: number, hours: number): Star => ({
  starredAt: time(hours),
  repo: {
    id: repo as RepoId,
    nodeId: `R_${repo}` as RepoNodeId,
    owner: "owner" as Login,
    name: `r${repo}` as RepoName,
    description: null,
    topics: [],
    language: null,
  },
});

const row = (repo: number, hours: number, observedHours = 10): Db.Star => ({
  accountId: 1 as GitHubAccountId,
  repoId: repo as RepoId,
  starredAt: time(hours),
  unstarredAt: null,
  observedAt: time(observedHours),
  source: "api",
});

const ids = (stars: ReadonlyArray<Star>) => stars.map((star) => star.repo.id as number);

const diff = (stored: DiffPage.Stored, page: ReadonlyArray<Star>, cursor = DiffPage.start) =>
  DiffPage.diffPage(stored, cursor, page);

describe("diffPage", () => {
  const stored = DiffPage.stored([row(1, 1), row(2, 2), row(3, 30, 40)], Option.some(time(10)));

  test("stops at the first star older than a stored star the last completed run observed", () => {
    const [, page] = diff(stored, [listed(9, 20), listed(2, 2), listed(1, 1)]);
    expect(ids(page.listed)).toEqual([9]);
    expect(ids(page.fresh)).toEqual([9]);
    expect(page.stopped).toBe(true);
  });

  test("reads past stored stars a later, unfinished run wrote", () => {
    const [, page] = diff(stored, [listed(3, 30), listed(9, 20), listed(2, 2), listed(1, 1)]);
    expect(ids(page.listed)).toEqual([3, 9]);
    expect(ids(page.fresh)).toEqual([9]);
  });

  test("reads every star that shares the stop star's starred_at", () => {
    const [, page] = diff(stored, [listed(2, 2), listed(8, 2), listed(1, 1)]);
    expect(ids(page.listed)).toEqual([8]);
    expect(ids(page.fresh)).toEqual([8]);
    expect(page.stopped).toBe(true);
  });

  test("carries a tie that reaches the end of a page into the next page", () => {
    const [cursor, first] = diff(stored, [listed(9, 20), listed(2, 2)]);
    expect([ids(first.listed), first.stopped]).toEqual([[9], false]);
    const [, second] = diff(stored, [listed(8, 2), listed(1, 1)], cursor);
    expect(ids(second.listed)).toEqual([8]);
    expect(second.stopped).toBe(true);
  });

  test("treats a stored repo with a new starred_at as fresh", () => {
    const [, page] = diff(stored, [listed(1, 25), listed(2, 2), listed(4, 1)]);
    expect(ids(page.fresh)).toEqual([1]);
    expect(page.stopped).toBe(true);
  });

  test("never stops without a completed run", () => {
    const [, page] = diff(DiffPage.stored([row(1, 1)], Option.none()), [listed(1, 1), listed(5, 0)]);
    expect(ids(page.listed)).toEqual([1, 5]);
    expect(page.stopped).toBe(false);
  });

  test("lists a repo once when the pages repeat it", () => {
    const [cursor] = diff(stored, [listed(7, 21)]);
    const [, page] = diff(stored, [listed(7, 21), listed(8, 20), listed(8, 20)], cursor);
    expect(ids(page.listed)).toEqual([8]);
  });
});

describe("report", () => {
  test("counts changes the database made, not the stars it was sent", () => {
    const stored = DiffPage.stored([row(1, 1), row(2, 2), row(3, 3)], Option.none());
    const [, page] = diff(stored, [listed(9, 20), listed(1, 15), listed(2, 2)]);
    const written = { ...page, starred: [9 as RepoId], enqueued: 4 };
    expect(DiffPage.report(stored, [written], { starred: [], unstarred: [3 as RepoId] }, false)).toEqual({
      listed: 3,
      added: 1,
      unchanged: 2,
      unstarred: 1,
      enqueued: 4,
      shifted: false,
    });
  });
});
