import type { View } from "@stargrep/ui";
import { type Audience, audienceOf } from "./audience.ts";
import type { Segment } from "./discover.ts";
import type { Example } from "./example.ts";
import type { Site } from "./preview.ts";
import type { LibraryRepo, PublicConfig, SearchResult, SyncStatus, Viewer } from "./rpc.ts";
import type { Params } from "./search-params.ts";
import type { SearchView } from "./search-state.ts";
import type { Refusal } from "./trouble.ts";

// An answer by meaning the server painted. A stale one is a search answer the server read from the API's answer cache
// past its fresh window, so the browser asks for it again and keeps it on screen until the new answer lands.
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

// Who is looking. Signing in or out reloads the whole page, so this holds across navigations.
export interface Session {
  readonly viewer: Viewer | null;
  readonly config: PublicConfig;
  // Stargrep's own GitHub stars for the header, or null when the server had no count in time.
  readonly repoStars: number | null;
  // The segment discover opens on, as this browser's cookie named it.
  readonly discover: Segment;
  readonly site: Site;
}

// A person's stars page. The page's audience carries the session's viewer.
export interface PageData extends Omit<Session, "viewer" | "discover"> {
  readonly kind: "stars";
  readonly audience: Audience;
  readonly query: string;
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

// A visitor's first look at stargrep, at / signed out: one person's answer to one question, as an example.
export interface LandingData {
  readonly kind: "landing";
  readonly site: Site;
  readonly example: Example;
}

// What / and /{login} show. Signed in, / is the viewer's own stars page.
export type StarsRouteData = LandingData | PageData;

export interface PageRequest {
  readonly login: string;
}

// The server reads the query, sort and filters from the address it renders. The browser never reloads the page for them.
export type Asked = PageRequest & Params;

// Who looks at whose stars, and what the page searches.
export const askedPage = (viewer: Viewer | null, { login, ...search }: Asked) => ({
  audience: audienceOf(viewer, login),
  query: search.q ?? "",
});
