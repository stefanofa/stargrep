import type { Sort, View } from "@stargrep/ui";
import { type Audience, audienceOf } from "./audience.ts";
import type { LibraryRepo, PublicConfig, SearchResult, SyncStatus, Viewer } from "./rpc.ts";
import type { SearchView } from "./search-state.ts";
import type { Refusal } from "./trouble.ts";

// An answer by meaning the server painted. A stale one is a search answer the server read from the API's answer cache
// past its fresh window, so the browser asks for it again and keeps it on screen until the new answer lands. The demo
// landing's own answer is never stale here, because the server refreshes it.
export interface Hits {
  readonly results: ReadonlyArray<SearchResult>;
  readonly stale: boolean;
}

// What the server already knows when it renders a stars page, so the page paints its first answer with no request.
export interface FirstAnswer {
  readonly query: string;
  readonly at: number;
  readonly sync: SyncStatus;
  // The answer by meaning, or null when the server painted keyword matches alone and left that search to the browser.
  readonly hits: Hits | null;
  readonly view: SearchView;
}

// Who is looking and which account the home page shows them. Signing in or out reloads the whole page, so this holds
// across navigations.
export interface Session {
  readonly viewer: Viewer | null;
  readonly config: PublicConfig;
  // Stargrep's own GitHub stars for the header, or null when the server had no count in time.
  readonly repoStars: number | null;
}

// The page's audience carries the session's viewer.
export interface PageData extends Omit<Session, "viewer"> {
  readonly audience: Audience;
  readonly query: string;
  // What the page searches when its address has no q.
  readonly defaultQuery: string;
  readonly first: FirstAnswer | null;
  // What the server learned about the owner's sync, so the first paint already shows an import, or a refusal this
  // browser remembers.
  readonly sync: SyncStatus | null;
  readonly refusal: Refusal | null;
  // The repo a shared link opens, so its panel opens as the page hydrates instead of once the library loads.
  readonly opened: LibraryRepo | null;
  // The view this browser picked, so the server paints it.
  readonly view: View | null;
}

export interface PageRequest {
  readonly login?: string | undefined;
}

// The server reads the query and sort from the address it renders. The browser never reloads the page for them.
export interface Asked extends PageRequest {
  readonly q?: string | undefined;
  readonly sort?: Sort | undefined;
}

// Who looks at whose stars, and what the page searches. The demo account opens on its example query.
export const askedPage = (viewer: Viewer | null, config: PublicConfig, { login, q }: Asked) => {
  const audience = audienceOf(viewer, config, login);
  const defaultQuery = audience.owner.demo ? config.demoQuery : "";
  return { audience, query: q ?? defaultQuery, defaultQuery };
};
