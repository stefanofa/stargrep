import type { LibraryEntry } from "./library-collection.ts";
import { lastStarredOn } from "./starred-on.ts";

const mostlyShown = 4;

// The topics at least two of someone's stars carry, most first, as the person tile says them.
export const mostlyOf = (topics: Iterable<readonly [topic: string, count: number]>) =>
  [...topics]
    .filter(([, count]) => count > 1)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, mostlyShown)
    .map(([topic]) => topic);

// What the person tile says about a library: the year of the first star, when the last one was, and what the stars
// mostly carry. Archived and gone repos count toward no topic, as on the taste tab.
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
    mostly: mostlyOf(topics),
  };
};
