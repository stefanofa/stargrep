import { describe, expect, test } from "bun:test";
import { checkedAgo, dayGroup, when } from "../src/lib/follow-time.ts";
import { isoAt } from "../src/lib/wall-clock.ts";

const at = Date.parse("2026-11-22T15:00:00Z");
const hoursAgo = (hours: number) => isoAt(at - hours * 3_600_000);

describe("follow times", () => {
  test("say a star's time in the largest unit that reads naturally", () => {
    expect([0.5, 1, 3, 20, 30, 80, 200].map((hours) => when(hoursAgo(hours), at))).toEqual([
      "30 min ago",
      "an hour ago",
      "3 hours ago",
      "20 hours ago",
      "yesterday",
      "Thursday",
      "Nov 14",
    ]);
  });

  test("group by UTC day, so the server and the browser agree", () => {
    expect([2, 14, 16, 40, 100, 200].map((hours) => dayGroup(hoursAgo(hours), at))).toEqual([
      "today",
      "today",
      "yesterday",
      "this week",
      "this week",
      "earlier",
    ]);
  });

  test("say when stars were last checked", () => {
    expect([0.3, 5, 30, 75].map((hours) => checkedAgo(hoursAgo(hours), at))).toEqual([
      "18 min ago",
      "5 hours ago",
      "a day ago",
      "3 days ago",
    ]);
  });
});
