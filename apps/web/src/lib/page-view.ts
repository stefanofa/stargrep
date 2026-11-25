import type { Sort } from "@stargrep/ui";
import { anyMatches, keywordTerms, matchesEvery } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { orders } from "./order.ts";
import { mergeResults } from "./results.ts";
import type { SearchResult, SyncStatus } from "./rpc.ts";
import { type SearchView, type Stage, searchView } from "./search-state.ts";
import type { Whose } from "./whose.ts";

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
  readonly find: (id: number) => LibraryEntry | undefined;
  readonly sync: SyncStatus | undefined;
  readonly semantic: Semantic;
  readonly sort: Sort;
  readonly at: number;
  readonly timeLeft: string | undefined;
  readonly whose: Whose;
}

export const liveView = (inputs: LiveInputs): SearchView => {
  const terms = keywordTerms(inputs.query);
  const merged = mergeResults({
    matched: matchesEvery(inputs.entries, terms),
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
      hasMatches: (words) => anyMatches(inputs.entries, words),
    },
    timeLeft: inputs.timeLeft,
    whose: inputs.whose,
  });
};
