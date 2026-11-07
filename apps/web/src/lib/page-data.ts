import type { Sort, View } from "@stargrep/ui";
import type { LibraryRepo, PublicConfig, SearchResult, SyncStatus, Viewer } from "./rpc.ts";
import type { SearchView } from "./search-state.ts";
import type { Refusal } from "./trouble.ts";
import { sameLogin } from "./whose.ts";

// What the server already knows when it renders a stars page, so the page paints its first answer with no request.
export interface FirstAnswer {
  readonly query: string;
  readonly at: number;
  readonly sync: SyncStatus;
  // The answer by meaning, or null when the server painted keyword matches alone and left that search to the browser.
  readonly hits: ReadonlyArray<SearchResult> | null;
  readonly view: SearchView;
}

// Who is looking and which account the home page shows them. Signing in or out reloads the whole page, so this holds
// across navigations.
export interface Session {
  readonly viewer: Viewer | null;
  readonly config: PublicConfig;
}

export interface PageData extends Session {
  readonly owner: string;
  readonly own: boolean;
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

// A visitor lands on the demo account with its example query. A signed-in viewer lands on their own stars. The demo
// account keeps its own spelling whatever case the address uses.
export const pageOwner = (viewer: Viewer | null, config: PublicConfig, { login, q }: Asked) => {
  const asked = login ?? viewer?.login ?? config.demoLogin;
  const own = viewer !== null && sameLogin(viewer.login, asked);
  const showcase = !own && sameLogin(asked, config.demoLogin);
  const owner = showcase ? config.demoLogin : asked;
  const defaultQuery = showcase ? config.demoQuery : "";
  return { owner, own, query: q ?? defaultQuery, defaultQuery, showcase };
};
