import { describe, expect, test } from "bun:test";
import { busiest, busiestWeekday, monthTicks, type TasteWeek, weekSpan, weekTicks } from "../src/lib/taste.ts";

// Weeks from Sunday 2026-01-04 on, each day holding the stars given for its week.
const weeks = (counts: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<TasteWeek> =>
  counts.map((days, index) => ({
    start: new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
      Date.parse("2026-01-04") + index * 7 * 86_400_000,
    ),
    days,
  }));

const quiet = [0, 0, 0, 0, 0, 0, 0];

describe("what the taste charts single out", () => {
  test("the busiest item is the latest of a tie, and nothing when every one is empty", () => {
    const months = [
      { month: "2026-01", stars: 4 },
      { month: "2026-02", stars: 9 },
      { month: "2026-03", stars: 9 },
      { month: "2026-04", stars: 2 },
    ];
    expect(busiest(months, (month) => month.stars)?.month).toBe("2026-03");
    expect(busiest([{ month: "2026-01", stars: 0 }], (month) => month.stars)).toBeUndefined();
  });

  test("the busiest weekday sums each weekday across the weeks, and the current week stops at today", () => {
    expect(
      busiestWeekday(
        weeks([
          [0, 1, 5, 0, 0, 0, 0],
          [0, 4, 0, 0, 0, 0, 0],
          [0, 3],
        ]),
      ),
    ).toBe("Mondays");
    expect(busiestWeekday(weeks([quiet]))).toBeUndefined();
  });

  test("a week's span names the month once, twice across a month's end, and ends today for the current week", () => {
    const [first, , , , end] = weeks([quiet, quiet, quiet, quiet, quiet]);
    expect(first && weekSpan(first)).toBe("Jan 4 to 10");
    expect(end && weekSpan(end)).toBe("Feb 1 to 7");
    expect(weekSpan({ start: "2026-03-29", days: [1, 2, 3, 4, 5, 6, 7] })).toBe("Mar 29 to Apr 4");
    expect(weekSpan({ start: "2026-11-22", days: [0, 3, 1, 2] })).toBe("Nov 22 to 25");
  });
});

describe("the taste charts' axes", () => {
  test("a month chart names its first, middle and last month at their bars", () => {
    const months = ["2025-12", "2026-01", "2026-02", "2026-03"].map((month) => ({ month, stars: 1 }));
    expect(monthTicks(months)).toEqual([
      { at: 0.125, label: "Dec 2025" },
      { at: 0.625, label: "Feb 2026" },
      { at: 0.875, label: "Mar 2026" },
    ]);
    expect(monthTicks(months.slice(0, 1))).toEqual([{ at: 0.5, label: "Dec 2025" }]);
  });

  test("a week grid names every other month, counted back from the latest, under the week of its first day", () => {
    // Jan 4 to Mar 7: February 1 falls in the fifth week and March 1 in the ninth.
    expect(weekTicks(weeks(Array.from({ length: 9 }, () => quiet)))).toEqual([{ at: 8 / 9, label: "Mar" }]);
    expect(weekTicks(weeks(Array.from({ length: 13 }, () => quiet)))).toEqual([
      { at: 4 / 13, label: "Feb" },
      { at: 12 / 13, label: "Apr" },
    ]);
  });
});
