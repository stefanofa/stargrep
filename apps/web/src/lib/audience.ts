import type { PublicConfig, SyncStatus, Viewer } from "./rpc.ts";
import { sameLogin, type Whose } from "./whose.ts";

export interface Owner {
  readonly login: string;
  // The demo account has a default query and its own hero subtitle.
  readonly demo: boolean;
}

// Who looks at whose stars. The tags match the server's sync Requester: a signed-out visitor is anyone, a signed-in
// viewer looks at someone else's stars, and the owner looks at their own.
export type Audience =
  | { readonly by: "anyone"; readonly owner: Owner }
  | { readonly by: "signed-in"; readonly viewer: Viewer; readonly owner: Owner }
  | { readonly by: "owner"; readonly viewer: Viewer; readonly owner: Owner };

export interface Policy {
  // The owner's library comes from the session-only library, anyone else's from the public stars pages.
  readonly library: "session" | "public";
  // The owner's page asks for a sync on every open. Other pages ask only for a login with nothing synced.
  readonly syncOnOpen: boolean;
}

const policies = {
  anyone: { library: "public", syncOnOpen: false },
  "signed-in": { library: "public", syncOnOpen: false },
  owner: { library: "session", syncOnOpen: true },
} as const satisfies Record<Audience["by"], Policy>;

export const policyOf = (audience: Audience): Policy => policies[audience.by];

// What a stars page puts above its search. The landing is a visitor's look at the demo account, under the hero and its
// butter sign-in tile. A person page is anyone else's stars, under that person's tile. The own page is the viewer's
// stars, with nothing above the search.
export type PageKind = "landing" | "person" | "own";

export const pageKindOf = (audience: Audience): PageKind => {
  if (audience.by === "owner") return "own";
  return audience.by === "anyone" && audience.owner.demo ? "landing" : "person";
};

// A visitor lands on the demo account. A signed-in viewer lands on their own stars. The demo account keeps its own
// spelling whatever case the address uses.
export const audienceOf = (viewer: Viewer | null, config: PublicConfig, login: string | undefined): Audience => {
  const asked = login ?? viewer?.login ?? config.demoLogin;
  if (viewer !== null && sameLogin(viewer.login, asked))
    return { by: "owner", viewer, owner: { login: asked, demo: false } };
  const demo = sameLogin(asked, config.demoLogin);
  const owner = { login: demo ? config.demoLogin : asked, demo };
  return viewer === null ? { by: "anyone", owner } : { by: "signed-in", viewer, owner };
};

export const whoseOf = (audience: Audience): Whose =>
  audience.by === "owner" ? { own: true } : { own: false, login: audience.owner.login };

// How many stars the page says the owner has: the viewer's own count on their page, or the sync's.
export const starredOf = (audience: Audience, sync: SyncStatus | undefined): number | null =>
  audience.by === "owner" ? audience.viewer.starredCount : (sync?.starredTotal ?? null);
