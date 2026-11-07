import type { Sort } from "@stargrep/ui";
import { keywordTerms } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { orders } from "./order.ts";
import { syncedAgo } from "./present.ts";
import { mergeResults } from "./results.ts";
import type { SearchResult, SyncStatus } from "./rpc.ts";
import { type SearchView, type Stage, searchView, type Whose } from "./search-state.ts";

// Where the search by meaning stands for the query on screen. A pending search keeps an earlier query's results, which
// stay on screen until its own answer lands.
export type Semantic =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly results: ReadonlyArray<SearchResult> }
  | { readonly kind: "answered"; readonly results: ReadonlyArray<SearchResult> }
  | { readonly kind: "failed" }
  | { readonly kind: "limited" };

export const hitsOf = (semantic: Semantic) => ("results" in semantic ? semantic.results : []);

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
    hits: hitsOf(inputs.semantic),
    find: inputs.find,
    at: inputs.at,
    order: inputs.sort === "best" ? undefined : orders[inputs.sort],
  });
  return searchView({
    stage: inputs.stage,
    search: {
      terms,
      ...merged,
      semantic: inputs.semantic.kind,
      hasMatches: (words) => inputs.entries.some(containsAll(words)),
    },
    synced: inputs.sync?.syncedAt ? syncedAgo(inputs.sync.syncedAt, inputs.at) : undefined,
    timeLeft: inputs.timeLeft,
    whose: inputs.whose,
  });
};
