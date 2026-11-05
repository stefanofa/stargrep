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
  readonly order?: ((a: LibraryEntry, b: LibraryEntry) => number) | undefined;
}

// The search reply is newer than the library, which reloads only after a sync, so a repo enriched since then has its
// summary only in the reply. The library adds what the reply leaves out: stars and when the user starred the repo.
export const withReply = (entry: LibraryEntry, hit: SearchResult): LibraryEntry => ({ ...entry, ...hit });

export interface Merged {
  readonly words: ReadonlyArray<Result>;
  readonly meaning: ReadonlyArray<Result>;
}

// Semantic hits only append after the keyword results, so no tile the user is reading moves when they arrive. An
// order the user picked sorts each group on its own, for the same reason.
export const mergeResults = ({ matched, terms, hits, find, at, order }: Merge): Merged => {
  const ranked = terms.length === 0 ? [] : matched.toSorted(byRelevance(terms)).slice(0, keywordLimit);
  const keyword = order === undefined ? ranked : ranked.toSorted(order);
  const seen = new Set(keyword.map((entry) => entry.id));
  const appended = hits.flatMap((hit) => {
    const entry = find(hit.id);
    if (entry === undefined || seen.has(hit.id)) return [];
    seen.add(hit.id);
    return [{ entry: withReply(entry, hit), values: hit.rankedBy.join(", ") }];
  });
  const meaning = order === undefined ? appended : appended.toSorted((a, b) => order(a.entry, b.entry));
  return {
    words: keyword.map((entry) => toResult(entry, terms, at)),
    meaning: meaning.map(({ entry, values }) => toResult(entry, terms, at, values)),
  };
};
