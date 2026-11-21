import type { LibraryEntry } from "./library-collection.ts";
import { orders } from "./order.ts";

const shown = 3;

// An archived repo GitHub still serves. A gone repo has no page left to visit, so it never counts.
export const dead = (entry: LibraryEntry) => entry.archived && !entry.gone;

export interface DeadStars {
  readonly count: number;
  // The most starred of them, most stars first.
  readonly top: ReadonlyArray<LibraryEntry>;
}

export const deadStars = (entries: ReadonlyArray<LibraryEntry>): DeadStars => {
  const archived = entries.filter(dead);
  return { count: archived.length, top: archived.toSorted(orders.stars).slice(0, shown) };
};
