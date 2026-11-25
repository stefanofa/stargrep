import type { Result } from "@stargrep/ui";
import { dead } from "./dead-stars.ts";
import type { LibraryEntry } from "./library-collection.ts";

// What the strip's chips filter on: a repo's language, and whether it is archived. The library's repos and a search's
// results both have it, so the chips count and filter whichever answer is on screen.
export interface Faceted {
  readonly language: string | null;
  readonly archived: boolean;
}

export const facetOf = (entry: LibraryEntry): Faceted => ({ language: entry.language, archived: dead(entry) });

export interface Facets {
  // Each language with how many repos it holds, most first.
  readonly languages: ReadonlyArray<readonly [language: string, count: number]>;
  readonly archived: number;
}

export const facetsOf = (repos: Iterable<Faceted>): Facets => {
  const languages = new Map<string, number>();
  let archived = 0;
  for (const repo of repos) {
    if (repo.language !== null) languages.set(repo.language, (languages.get(repo.language) ?? 0) + 1);
    if (repo.archived) archived += 1;
  }
  return { languages: [...languages].toSorted((a, b) => b[1] - a[1]), archived };
};

// Whether a repo passes the chips that are on.
export const keeps =
  (lang: string | undefined, archived: boolean) =>
  (repo: Faceted): boolean =>
    (lang === undefined || repo.language === lang) && (!archived || repo.archived);

// The library's filters from the page's params, every one that is set at once. starredAt is an ISO time in UTC, so it
// starts with the month or the day a starred filter names.
export const libraryFilter =
  (lang: string | undefined, archived: boolean, starred = "", topic?: string) =>
  (entry: LibraryEntry) =>
    keeps(lang, archived)(facetOf(entry)) &&
    entry.starredAt.startsWith(starred) &&
    (topic === undefined || entry.topics.includes(topic));

export const resultFacet = (result: Result): Faceted => ({
  language: result.language,
  archived: result.activity.state === "archived",
});
