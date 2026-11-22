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
  // How many saves each login has in flight.
  readonly pending: ReadonlyMap<string, number>;
  readonly refused: ReadonlyMap<string, Refusal>;
}

let state: State = { load: "idle", following: new Map(), pending: new Map(), refused: new Map() };
const listeners = new Set<() => void>();

const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const counted = (from: ReadonlyMap<string, number>, keys: ReadonlyArray<string>, by: 1 | -1) => {
  const next = new Map(from);
  for (const key of keys) {
    const count = (next.get(key) ?? 0) + by;
    if (count > 0) next.set(key, count);
    else next.delete(key);
  }
  return next;
};

// Each login's saves reach the API one after another, in the order asked, so the server ends where the last change
// left it. A quick unfollow and follow again can't land in the other order and leave the two disagreeing.
const queues = new Map<string, Promise<void>>();

const inTurn = <A>(keys: ReadonlyArray<string>, save: () => Promise<A>): Promise<A> => {
  const turn = Promise.all(keys.map((key) => queues.get(key))).then(save);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) queues.set(key, settled);
  return turn;
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
  set({ following, pending: counted(state.pending, keys, 1), refused });
  return inTurn(keys, () => api().follow({ logins: [...logins], source })).then(
    (result): FollowResult => {
      const kept = new Set(result.following.map(loginKey));
      const next = new Map(state.following);
      const refusals = new Map(state.refused);
      for (const key of keys)
        if (!kept.has(key) && !before.has(key)) {
          next.delete(key);
          if (result.full) refusals.set(key, "full");
        }
      set({ following: next, pending: counted(state.pending, keys, -1), refused: refusals });
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
      set({ following: next, pending: counted(state.pending, keys, -1), refused: refusals });
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
  set({ following, pending: counted(state.pending, [key], 1), refused });
  return inTurn([key], () => api().unfollow({ login })).then(
    () => {
      set({ pending: counted(state.pending, [key], -1) });
      return true;
    },
    (error: unknown) => {
      const back = new Map(state.following);
      if (since !== undefined) back.set(key, since);
      set({
        following: back,
        pending: counted(state.pending, [key], -1),
        refused: new Map(state.refused).set(key, refusalOf(error)),
      });
      return false;
    },
  );
};

// A follow a signed-out visitor asked for waits in this tab's sessionStorage under a random single-use nonce, and the
// sign-in comes back with only the nonce in the address. A link can name a nonce but not plant the intent, so an address
// alone never changes anyone's follows.
const intentKey = "stargrep-follow-intent";
export const intentParam = "follow-intent";

interface Intent {
  readonly nonce: string;
  readonly logins: ReadonlyArray<string>;
}

export const signInToFollow = (logins: ReadonlyArray<string>) => {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - the browser's own random ID, for a nonce no server sees.
  const nonce = crypto.randomUUID();
  try {
    sessionStorage.setItem(intentKey, JSON.stringify({ nonce, logins } satisfies Intent));
  } catch {}
  const url = new URL(location.href);
  url.searchParams.set(intentParam, nonce);
  return signIn(`${url.pathname}${url.search}`);
};

// The intent saved under the nonce, removed whether or not it matches, so it applies at most once.
const takeIntent = (nonce: string): ReadonlyArray<string> | undefined => {
  try {
    const raw = sessionStorage.getItem(intentKey);
    sessionStorage.removeItem(intentKey);
    if (raw === null) return undefined;
    const intent = JSON.parse(raw) as Partial<Intent>;
    return intent.nonce === nonce && Array.isArray(intent.logins) ? intent.logins : undefined;
  } catch {
    return undefined;
  }
};

// Applies the follow a sign-in came back with, when the address names the nonce this tab saved before it left. The first
// follow control to mount takes the nonce and the intent, so it applies once. It drops the nonce from the address either
// way, and answers whom it followed, or nothing.
export const followOnReturn = async (): Promise<ReadonlyArray<string> | undefined> => {
  const url = new URL(location.href);
  const nonce = url.searchParams.get(intentParam);
  if (nonce === null) return undefined;
  url.searchParams.delete(intentParam);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const logins = takeIntent(nonce)?.filter((login) => typeof login === "string" && login !== "");
  if (logins === undefined || logins.length === 0) return undefined;
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
