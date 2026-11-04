import type { Result } from "@stargrep/ui";
import { score } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { toResult } from "./present.ts";
import type { SearchResult } from "./rpc.ts";

const keywordLimit = 60;

const byRelevance = (terms: ReadonlyArray<string>) => (a: LibraryEntry, b: LibraryEntry) =>
  score(b, terms) - score(a, terms) || (b.stars ?? -1) - (a.stars ?? -1) || b.starredAt.localeCompare(a.starredAt);

export interface Merge {
  readonly matched: ReadonlyArray<LibraryEntry>;
  readonly terms: ReadonlyArray<string>;
  readonly hits: ReadonlyArray<SearchResult>;
  readonly find: (id: number) => LibraryEntry | undefined;
  readonly at: number;
}

// The search reply is newer than the library, which reloads only after a sync, so a repo enriched since then has its
// summary only in the reply. The library adds what the reply leaves out: stars and when the user starred the repo.
export const withReply = (entry: LibraryEntry, hit: SearchResult): LibraryEntry => ({ ...entry, ...hit });

// Semantic hits only append after the keyword results, so no tile the user is reading moves when they arrive.
export const mergeResults = ({ matched, terms, hits, find, at }: Merge): ReadonlyArray<Result> => {
  const keyword = terms.length === 0 ? [] : matched.toSorted(byRelevance(terms)).slice(0, keywordLimit);
  const seen = new Set(keyword.map((entry) => entry.id));
  const appended = hits.flatMap((hit) => {
    const entry = find(hit.id);
    if (entry === undefined || seen.has(hit.id)) return [];
    seen.add(hit.id);
    return [toResult(withReply(entry, hit), terms, at, hit.rankedBy.join(", "))];
  });
  return [...keyword.map((entry) => toResult(entry, terms, at)), ...appended];
};
