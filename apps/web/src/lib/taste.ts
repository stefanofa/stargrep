import type { Taste } from "./rpc.ts";
import type { Params } from "./search-params.ts";
import { loginPage } from "./stars-route.ts";

export type TasteMonth = Taste["months"][number];
export type TasteWeek = Taste["weeks"][number];

// A place along a chart's axis, as a fraction of its width, and what it says there.
export interface Tick {
  readonly at: number;
  readonly label: string;
}

const day = 86_400_000;
const utc = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
const monthYear = utc({ month: "short", year: "numeric" });
const monthOnly = utc({ month: "short" });
const monthDay = utc({ month: "short", day: "numeric" });
const dayOnly = utc({ day: "numeric" });
const weekdayDate = utc({ weekday: "short", month: "short", day: "numeric" });
const fullDate = utc({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
// en-CA writes a date as 2026-03-10.
const isoDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });

const monthStart = (month: string) => Date.parse(`${month}-01T00:00:00Z`);

// "Dec 2025" for 2025-12, or "Dec" short.
export const monthName = (month: string, short = false) => (short ? monthOnly : monthYear).format(monthStart(month));

// The day `offset` days after a week's Sunday, such as 2026-03-10.
export const dayOf = (start: string, offset: number) => isoDay.format(Date.parse(`${start}T00:00:00Z`) + offset * day);

// "Tue, Mar 10" for a tooltip, or "Tuesday, March 10, 2026" for a screen reader.
export const dayName = (date: string, long = false) =>
  (long ? fullDate : weekdayDate).format(Date.parse(`${date}T00:00:00Z`));

export const weekStars = (week: TasteWeek) => week.days.reduce((sum, stars) => sum + stars, 0);

// "Mar 8 to 14", or "Feb 26 to Mar 4" across two months. The current week ends today.
export const weekSpan = (week: TasteWeek) => {
  const first = Date.parse(`${week.start}T00:00:00Z`);
  const last = first + (week.days.length - 1) * day;
  const sameMonth = monthOnly.format(first) === monthOnly.format(last);
  return `${monthDay.format(first)} to ${(sameMonth ? dayOnly : monthDay).format(last)}`;
};

// The item with the most, the latest on a tie, or undefined when every one has none.
export const busiest = <T>(items: ReadonlyArray<T>, count: (item: T) => number): T | undefined =>
  items.reduce<T | undefined>(
    (best, item) => (count(item) > 0 && (best === undefined || count(item) >= count(best)) ? item : best),
    undefined,
  );

const weekdays = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

// The weekday with the most stars across the weeks, such as Tuesdays.
export const busiestWeekday = (weeks: ReadonlyArray<TasteWeek>) => {
  const totals = weekdays.map((name, index) => ({
    name,
    stars: weeks.reduce((sum, week) => sum + (week.days[index] ?? 0), 0),
  }));
  return busiest(totals, (weekday) => weekday.stars)?.name;
};

// A month chart's axis: its first month, the one in the middle and its last.
export const monthTicks = (months: ReadonlyArray<TasteMonth>): ReadonlyArray<Tick> =>
  [...new Set(months.length === 0 ? [] : [0, Math.floor(months.length / 2), months.length - 1])].map((index) => ({
    at: (index + 0.5) / months.length,
    label: monthName(months[index]?.month ?? ""),
  }));

// A week grid's axis: every other month, counted back from the latest, under the week its first day falls in.
export const weekTicks = (weeks: ReadonlyArray<TasteWeek>): ReadonlyArray<Tick> => {
  const starts = weeks.flatMap((week, column) => {
    const first = week.days.map((_, offset) => dayOf(week.start, offset)).find((date) => date.endsWith("-01"));
    return first === undefined ? [] : [{ at: column / weeks.length, label: monthName(first.slice(0, 7), true) }];
  });
  return starts.filter((_, index) => (starts.length - 1 - index) % 2 === 0);
};

// A link to a login's stars with one filter set, such as the month a bar stands for.
export const starsOf = (login: string, search: Params) => ({ ...loginPage(login), search });

// What the page says about the person, in the second person on your own page.
export const tasteWords = (login: string, own: boolean) =>
  own
    ? {
        year: "your year",
        languages: "languages you star",
        topics: "topics you star",
        alike: "stars like yours",
        archived: "archived since you starred",
        chips: "a chip opens your stars on that topic",
      }
    : {
        year: "their year",
        languages: "languages they star",
        topics: "topics they star",
        alike: `stars like @${login}'s`,
        archived: "archived since they starred",
        chips: "a chip opens their stars on that topic",
      };

export type TasteWords = ReturnType<typeof tasteWords>;
