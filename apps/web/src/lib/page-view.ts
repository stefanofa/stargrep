import type { Sort } from "@stargrep/ui";
import { keywordTerms } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { orders } from "./order.ts";
import { syncedAgo } from "./present.ts";
import { mergeResults } from "./results.ts";
import type { SearchResult, SyncStatus } from "./rpc.ts";
import { type SearchView, type Stage, searchView, type Whose } from "./search-state.ts";

export interface Semantic {
  readonly results: ReadonlyArray<SearchResult>;
  readonly pending: boolean;
  readonly failed: boolean;
}

export interface LiveInputs {
  readonly query: string;
  readonly stage: Stage;
  readonly entries: ReadonlyArray<LibraryEntry>;
  readonly matched: ReadonlyArray<LibraryEntry>;
  readonly find: (id: number) => LibraryEntry | undefined;
  readonly sync: SyncStatus | undefined;
  readonly semantic: Semantic;
  readonly sort: Sort;
  readonly at: number;
  readonly timeLeft: string | undefined;
  readonly whose: Whose;
}

// The library's live query matches each term with ilike '%term%' on the entry's lowercased search text, and terms are
// lowercased with the wildcards stripped, so a substring test gives the same rows.
const containsAll = (terms: ReadonlyArray<string>) => (entry: LibraryEntry) =>
  terms.every((term) => entry.text.includes(term));

export const matchesEvery = (entries: ReadonlyArray<LibraryEntry>, terms: ReadonlyArray<string>) =>
  terms.length === 0 ? [] : entries.filter(containsAll(terms));

export const liveView = (inputs: LiveInputs): SearchView => {
  const terms = keywordTerms(inputs.query);
  const merged = mergeResults({
    matched: inputs.matched,
    terms,
    hits: inputs.semantic.results,
    find: inputs.find,
    at: inputs.at,
    order: inputs.sort === "best" ? undefined : orders[inputs.sort],
  });
  return searchView({
    stage: inputs.stage,
    search: {
      terms,
      ...merged,
      pending: inputs.semantic.pending,
      failed: inputs.semantic.failed,
      hasMatches: (words) => inputs.entries.some(containsAll(words)),
    },
    synced: inputs.sync?.syncedAt ? syncedAgo(inputs.sync.syncedAt, inputs.at) : undefined,
    timeLeft: inputs.timeLeft,
    whose: inputs.whose,
  });
};
