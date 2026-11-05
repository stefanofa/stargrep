import type { Sort } from "@stargrep/ui";
import type { LibraryEntry } from "./library-collection.ts";

type Compare = (a: LibraryEntry, b: LibraryEntry) => number;

const starred: Compare = (a, b) => b.starredAt.localeCompare(a.starredAt);

export const orders: Record<Exclude<Sort, "best">, Compare> = {
  starred,
  stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
  pushed: (a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
};

export const libraryOrder = (sort: Sort): Compare => (sort === "best" ? starred : orders[sort]);
