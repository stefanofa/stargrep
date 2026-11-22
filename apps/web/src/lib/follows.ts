import { loginKey } from "@stargrep/github/login";
import { useEffect, useSyncExternalStore } from "react";
import { signIn } from "./auth-client.ts";
import { api, wireCode } from "./rpc.ts";
import { isoAt, wallNow } from "./wall-clock.ts";

// Whom the signed-in viewer follows, shared by every follow control on the page. It loads once per page load, and
// every follow and unfollow changes it at once and changes it back when the save fails.
type Load = "idle" | "loading" | "ready" | "failed";

// Why the last change to a login didn't save.
export type Refusal = "failed" | "limited" | "full";

interface State {
  readonly load: Load;
  // Lowercase login to when the follow started, the newest first.
  readonly following: ReadonlyMap<string, string>;
  readonly pending: ReadonlySet<string>;
  readonly refused: ReadonlyMap<string, Refusal>;
}

let state: State = { load: "idle", following: new Map(), pending: new Set(), refused: new Map() };
const listeners = new Set<() => void>();

const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const toggled = <A>(from: ReadonlySet<A>, items: ReadonlyArray<A>, add: boolean) => {
  const next = new Set(from);
  for (const item of items) add ? next.add(item) : next.delete(item);
  return next;
};

const refusalOf = (error: unknown): Refusal => (wireCode(error) === "TOO_MANY_REQUESTS" ? "limited" : "failed");

// The logins followed or unfollowed since the list started loading.
const touched = new Set<string>();

const load = () => {
  if (state.load === "loading" || state.load === "ready") return;
  set({ load: "loading" });
  touched.clear();
  Promise.resolve()
    .then(() => api().followedLogins())
    .then(
      ({ follows }) => {
        // A follow or unfollow made while the list loaded is newer than the list, so it stands.
        const following = new Map(follows.map(({ login, followedAt }) => [loginKey(login), followedAt]));
        for (const key of touched) {
          const since = state.following.get(key);
          if (since === undefined) following.delete(key);
          else following.set(key, since);
        }
        set({ load: "ready", following });
      },
      () => set({ load: "failed" }),
    );
};

export interface FollowResult {
  readonly following: ReadonlyArray<string>;
  readonly total: number;
}

// Follows the logins at once, then keeps the ones the API followed. A login the cap left out is refused as full.
export const follow = (logins: ReadonlyArray<string>, source: "stargrep" | "github" = "stargrep") => {
  const keys = logins.map(loginKey);
  for (const key of keys) touched.add(key);
  const before = state.following;
  const now = isoAt(wallNow());
  const following = new Map(before);
  for (const key of keys) if (!following.has(key)) following.set(key, now);
  const refused = new Map(state.refused);
  for (const key of keys) refused.delete(key);
  set({ following, pending: toggled(state.pending, keys, true), refused });
  return api()
    .follow({ logins: [...logins], source })
    .then(
      (result): FollowResult => {
        const kept = new Set(result.following.map(loginKey));
        const next = new Map(state.following);
        const refusals = new Map(state.refused);
        for (const key of keys)
          if (!kept.has(key) && !before.has(key)) {
            next.delete(key);
            if (result.full) refusals.set(key, "full");
          }
        set({ following: next, pending: toggled(state.pending, keys, false), refused: refusals });
        return result;
      },
      (error: unknown) => {
        const next = new Map(state.following);
        const refusals = new Map(state.refused);
        for (const key of keys)
          if (!before.has(key)) {
            next.delete(key);
            refusals.set(key, refusalOf(error));
          }
        set({ following: next, pending: toggled(state.pending, keys, false), refused: refusals });
        return undefined;
      },
    );
};

export const unfollow = (login: string) => {
  const key = loginKey(login);
  touched.add(key);
  const since = state.following.get(key);
  const following = new Map(state.following);
  following.delete(key);
  const refused = new Map(state.refused);
  refused.delete(key);
  set({ following, pending: toggled(state.pending, [key], true), refused });
  return api()
    .unfollow({ login })
    .then(
      () => {
        set({ pending: toggled(state.pending, [key], false) });
        return true;
      },
      (error: unknown) => {
        const back = new Map(state.following);
        if (since !== undefined) back.set(key, since);
        set({
          following: back,
          pending: toggled(state.pending, [key], false),
          refused: new Map(state.refused).set(key, refusalOf(error)),
        });
        return false;
      },
    );
};

// The page asks GitHub to sign in and comes back with ?follow= naming whom to follow, so the follow applies on return.
export const followParam = "follow";

export const signInToFollow = (logins: ReadonlyArray<string>) => {
  const url = new URL(location.href);
  url.searchParams.set(followParam, logins.join(","));
  return signIn(`${url.pathname}${url.search}`);
};

let returned = false;

// Applies the follow a sign-in came back with, once per page load, and drops the parameter from the address. Answers
// whom it followed, or nothing.
export const followOnReturn = async (): Promise<ReadonlyArray<string> | undefined> => {
  if (returned) return undefined;
  returned = true;
  const url = new URL(location.href);
  const asked = url.searchParams.get(followParam);
  if (asked === null) return undefined;
  url.searchParams.delete(followParam);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const logins = asked.split(",").filter((login) => login !== "");
  if (logins.length === 0) return undefined;
  const result = await follow(logins.slice(0, 100));
  return result?.following;
};

export interface Follows {
  readonly ready: boolean;
  readonly count: number;
  readonly isFollowing: (login: string) => boolean;
  readonly since: (login: string) => string | undefined;
  readonly isPending: (login: string) => boolean;
  readonly refusal: (login: string) => Refusal | undefined;
}

// A list that failed to load reads as following nobody, so every control still works, and a follow saves as usual.
const view = (current: State): Follows => ({
  ready: current.load === "ready" || current.load === "failed",
  count: current.following.size,
  isFollowing: (login) => current.following.has(loginKey(login)),
  since: (login) => current.following.get(loginKey(login)),
  isPending: (login) => current.pending.has(loginKey(login)),
  refusal: (login) => current.refused.get(loginKey(login)),
});

const idle = view(state);
let cached: readonly [State, Follows] = [state, idle];
const snapshot = () => {
  if (cached[0] !== state) cached = [state, view(state)];
  return cached[1];
};

// A signed-out viewer follows nobody, and the server renders before anything loads.
export const useFollows = (signedIn: boolean): Follows => {
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn]);
  return useSyncExternalStore(subscribe, snapshot, () => idle);
};
