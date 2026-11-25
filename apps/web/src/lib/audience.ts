import type { SyncStatus, Viewer } from "./rpc.ts";
import { sameLogin, type Whose } from "./whose.ts";

export interface Owner {
  readonly login: string;
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

// A signed-in viewer asking for their own login is the owner.
export const audienceOf = (viewer: Viewer | null, login: string): Audience => {
  const owner = { login };
  if (viewer === null) return { by: "anyone", owner };
  return sameLogin(viewer.login, login) ? { by: "owner", viewer, owner } : { by: "signed-in", viewer, owner };
};

export const whoseOf = (audience: Audience): Whose =>
  audience.by === "owner" ? { own: true } : { own: false, login: audience.owner.login };

// How many stars the page says the owner has: the viewer's own count on their page, or the sync's.
export const starredOf = (audience: Audience, sync: SyncStatus | undefined): number | null =>
  audience.by === "owner" ? audience.viewer.starredCount : (sync?.starredTotal ?? null);
