import * as Db from "@stargrep/db";
import type { GitHubAccountId } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// The week grid ends with the current week. Weeks start on Sunday, as GitHub's contribution calendar's do, so the two
// can share a grid.
export const gridWeeks = 52;

// How many of an account's most starred topics its taste lists.
export const topTopics = 12;

export interface Month {
  // The month in UTC, such as 2025-12.
  readonly month: string;
  readonly stars: number;
}

export interface Week {
  // The week's Sunday in UTC, such as 2026-03-08.
  readonly start: string;
  // How many stars each day held from Sunday on. The current week stops at today.
  readonly days: ReadonlyArray<number>;
}

export interface Calendar {
  // Every month from the first star's to the current one, oldest first, the empty ones included.
  readonly months: ReadonlyArray<Month>;
  // The last gridWeeks weeks, oldest first.
  readonly weeks: ReadonlyArray<Week>;
  // How many stars the weeks hold.
  readonly lastYear: number;
}

const dayOf = DateTime.formatIsoDateUtc;
const monthOf = (day: string) => day.slice(0, 7);
// Months counted from year 0, so two months are a subtraction apart.
const monthNumber = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthText = (number: number) => `${Math.floor(number / 12)}-${String((number % 12) + 1).padStart(2, "0")}`;

// Folds an account's stars per day into months and the week grid, all in UTC. Days after now count toward neither.
export const calendar = (days: ReadonlyArray<Db.StarDay>, now: DateTime.Utc): Calendar => {
  const today = dayOf(now);
  const byDay = new Map(days.map((day) => [day.day, day.stars]));
  const byMonth = new Map<string, number>();
  for (const { day, stars } of days)
    if (day <= today) byMonth.set(monthOf(day), (byMonth.get(monthOf(day)) ?? 0) + stars);

  const firstWeek = DateTime.subtract(DateTime.startOf(now, "week"), { weeks: gridWeeks - 1 });
  const weeks = Array.from({ length: gridWeeks }, (_, week) => {
    const start = DateTime.add(firstWeek, { weeks: week });
    const dates = Array.from({ length: 7 }, (_, offset) => dayOf(DateTime.add(start, { days: offset })));
    return { start: dayOf(start), days: dates.filter((day) => day <= today).map((day) => byDay.get(day) ?? 0) };
  });

  const first = days[0] === undefined ? monthNumber(today) + 1 : monthNumber(days[0].day);
  const months = Array.from({ length: Math.max(0, monthNumber(today) - first + 1) }, (_, index) => {
    const month = monthText(first + index);
    return { month, stars: byMonth.get(month) ?? 0 };
  });

  return {
    months,
    weeks,
    lastYear: weeks.reduce((sum, week) => sum + week.days.reduce((total, stars) => total + stars, 0), 0),
  };
};

export interface Taste extends Calendar {
  readonly languages: Db.StarLanguages;
  readonly topics: ReadonlyArray<Db.StarTopic>;
  // Current stars of repos that are archived now and that GitHub still serves.
  readonly archived: number;
  // Stars unstarred since the current UTC year began, as full syncs noticed them.
  readonly unstarredThisYear: number;
}

// Reads what an account stars and when, from indexes only, in parallel.
export const read = Effect.fn("Taste.read")(function* (accountId: GitHubAccountId) {
  const db = yield* Db.Db;
  const now = yield* DateTime.now;
  const [days, languages, topics, churn] = yield* Effect.all(
    [
      db.stars.days(accountId),
      db.stars.languages(accountId),
      db.stars.topics(accountId, topTopics),
      db.stars.churn(accountId, DateTime.startOf(now, "year")),
    ],
    { concurrency: 4 },
  );
  return {
    ...calendar(days, now),
    languages,
    topics,
    archived: churn.archived,
    unstarredThisYear: churn.unstarred,
  } satisfies Taste;
});
