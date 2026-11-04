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
  },
});

const row = (repo: number, hours: number): Db.Star => ({
  accountId: 1 as GitHubAccountId,
  repoId: repo as RepoId,
  starredAt: time(hours),
  unstarredAt: null,
  observedAt: time(hours),
  source: "api",
});

const ids = (stars: ReadonlyArray<Star>) => stars.map((star) => star.repo.id as number);

describe("diffPage", () => {
  const stored = DiffPage.stored([row(1, 1), row(2, 2), row(3, 30)], Option.some(time(10)));

  test("stops at the first stored star the last completed run saw", () => {
    const diff = DiffPage.diffPage(stored, new Set(), [listed(9, 20), listed(2, 2), listed(1, 1)]);
    expect(ids(diff.listed)).toEqual([9]);
    expect(ids(diff.fresh)).toEqual([9]);
    expect(diff.stopped).toBe(true);
  });

  test("reads past stored stars newer than the last completed run", () => {
    const diff = DiffPage.diffPage(stored, new Set(), [listed(3, 30), listed(9, 20), listed(2, 2)]);
    expect(ids(diff.listed)).toEqual([3, 9]);
    expect(ids(diff.fresh)).toEqual([9]);
    expect(diff.stopped).toBe(true);
  });

  test("treats a stored repo with a new starred_at as fresh", () => {
    const diff = DiffPage.diffPage(stored, new Set(), [listed(1, 25), listed(2, 2)]);
    expect(ids(diff.fresh)).toEqual([1]);
    expect(diff.stopped).toBe(true);
  });

  test("never stops without a completed run", () => {
    const diff = DiffPage.diffPage(DiffPage.stored([row(1, 1)], Option.none()), new Set(), [listed(1, 1)]);
    expect(ids(diff.listed)).toEqual([1]);
    expect(diff.fresh).toEqual([]);
    expect(diff.stopped).toBe(false);
  });

  test("lists a repo once when the pages repeat it", () => {
    const diff = DiffPage.diffPage(stored, new Set([7 as RepoId]), [listed(7, 21), listed(8, 20), listed(8, 20)]);
    expect(ids(diff.listed)).toEqual([8]);
  });
});

describe("report", () => {
  test("counts added, re-starred, unchanged, unstarred, and enqueued stars", () => {
    const stored = DiffPage.stored([row(1, 1), row(2, 2), row(3, 3)], Option.none());
    const page = DiffPage.diffPage(stored, new Set(), [listed(9, 20), listed(1, 15), listed(2, 2)]);
    expect(DiffPage.report(stored, [{ ...page, enqueued: 4 }], 1)).toEqual({
      listed: 3,
      added: 2,
      unchanged: 1,
      unstarred: 1,
      enqueued: 4,
    });
  });
});
