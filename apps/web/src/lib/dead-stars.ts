import type { LibraryEntry } from "./library-collection.ts";

// An archived repo GitHub still serves. A gone repo has no page left to visit, so it never counts.
export const dead = (entry: LibraryEntry) => entry.archived && !entry.gone;
