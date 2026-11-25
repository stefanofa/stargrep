import * as DateTime from "effect/DateTime";
import type { LibraryEntry } from "./library-collection.ts";

const mostlyShown = 4;
const day = 86_400_000;
const shortDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
const yearOf = (at: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(at)).slice(0, 4);

// When the last star was, in UTC days: today, yesterday, a day this year, or a day with its year.
export const lastStarredOn = (iso: string, at: number) => {
  const days = Math.floor(at / day) - Math.floor(millis(iso) / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return (iso.startsWith(yearOf(at)) ? shortDay : longDay).format(millis(iso));
};

// What the person tile says about a library: the year of the first star, when the last one was, and the topics at
// least two of the stars carry, most first. Archived and gone repos count toward no topic, as on the taste tab.
export const personStars = (entries: ReadonlyArray<LibraryEntry>, at: number) => {
  let first: string | undefined;
  let last: string | undefined;
  const topics = new Map<string, number>();
  for (const entry of entries) {
    if (first === undefined || entry.starredAt < first) first = entry.starredAt;
    if (last === undefined || entry.starredAt > last) last = entry.starredAt;
    if (!entry.archived && !entry.gone)
      for (const topic of entry.topics) topics.set(topic, (topics.get(topic) ?? 0) + 1);
  }
  return {
    kind: "starred" as const,
    since: first?.slice(0, 4),
    last: last === undefined ? undefined : lastStarredOn(last, at),
    mostly: [...topics]
      .filter(([, count]) => count > 1)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, mostlyShown)
      .map(([topic]) => topic),
  };
};
