import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Taste from "./taste.ts";

// A Wednesday, so the current week holds Sunday to Wednesday.
const now = DateTime.makeUnsafe("2026-11-25T12:00:00Z");

describe("calendar", () => {
  test("fills every month from the first star's to now, across a year, and drops days after now", () => {
    const { months } = Taste.calendar(
      [
        { day: "2025-11-30", stars: 2 },
        { day: "2026-01-31", stars: 1 },
        { day: "2026-02-01", stars: 4 },
        { day: "2026-11-25", stars: 3 },
        { day: "2026-11-26", stars: 9 },
      ],
      now,
    );
    expect(months.map((month) => month.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(months.filter((month) => month.stars > 0)).toEqual([
      { month: "2025-11", stars: 2 },
      { month: "2026-01", stars: 1 },
      { month: "2026-02", stars: 4 },
      { month: "2026-11", stars: 3 },
    ]);
  });

  test("lays the last 52 weeks out from Sunday, the current week cut at today, and totals them", () => {
    const { weeks, lastYear } = Taste.calendar(
      [
        { day: "2025-11-29", stars: 5 },
        { day: "2025-11-30", stars: 1 },
        { day: "2025-12-02", stars: 2 },
        { day: "2026-11-22", stars: 3 },
        { day: "2026-11-25", stars: 4 },
        { day: "2026-11-26", stars: 9 },
      ],
      now,
    );
    expect(weeks).toHaveLength(Taste.gridWeeks);
    expect(weeks[0]).toEqual({ start: "2025-11-30", days: [1, 0, 2, 0, 0, 0, 0] });
    expect(weeks.at(-1)).toEqual({ start: "2026-11-22", days: [3, 0, 0, 4] });
    expect(weeks.slice(1, -1).every((week) => week.days.length === 7 && week.days.every((day) => day === 0))).toBe(
      true,
    );
    expect(lastYear).toBe(10);
  });

  test("an account with no stars has no months and an empty grid", () => {
    const { months, weeks, lastYear } = Taste.calendar([], now);
    expect([months, weeks.length, lastYear]).toEqual([[], Taste.gridWeeks, 0]);
  });
});
