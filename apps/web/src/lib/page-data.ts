import type { Sort } from "@stargrep/ui";
import type { PlannedSyncStatus, PublicConfig } from "./planned.ts";
import type { Refusal } from "./refusals.ts";
import type { SearchResult, Viewer } from "./rpc.ts";
import type { SearchView } from "./search-state.ts";

// What the server already knows when it renders a stars page, so the page paints its first answer with no request.
export interface FirstAnswer {
  readonly query: string;
  readonly at: number;
  readonly sync: PlannedSyncStatus;
  readonly hits: ReadonlyArray<SearchResult>;
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
  readonly first: FirstAnswer | null;
  // What the server learned about the owner's sync, so the first paint already shows an import or a refusal.
  readonly sync: PlannedSyncStatus | null;
  readonly refusal: Refusal | null;
}

export interface PageRequest {
  readonly login?: string | undefined;
}

// The server reads the query and sort from the address it renders. The browser never reloads the page for them.
export interface Asked extends PageRequest {
  readonly q?: string | undefined;
  readonly sort?: Sort | undefined;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// A visitor lands on the demo account with its example query. A signed-in viewer lands on their own stars.
export const pageOwner = (viewer: Viewer | null, config: PublicConfig, { login, q }: Asked) => {
  const owner = login ?? viewer?.login ?? config.demoLogin;
  const own = viewer !== null && same(viewer.login, owner);
  const showcase = !own && same(owner, config.demoLogin);
  return { owner, own, query: q ?? (showcase ? config.demoQuery : ""), showcase };
};
