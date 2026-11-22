import { useEffect, useRef, useState } from "react";
import { capture } from "./analytics.ts";
import type { Audience } from "./audience.ts";
import { api, type NewToYou } from "./rpc.ts";

// The tile lists this many, and "see all" the rest of the answer.
export const firstShown = 3;
export const listed = 48;

export type Shared = NewToYou & { readonly shared: number };

// What a signed-in viewer has in common with someone else's stars. The answer says nothing until the viewer's own stars
// have synced, and nothing when the API refuses.
export type NewToYouState =
  | { readonly kind: "asking" }
  | { readonly kind: "unsynced" }
  | { readonly kind: "found"; readonly found: Shared }
  | { readonly kind: "failed" };

// Two accounts with nothing in common and nothing to suggest have nothing to say about each other, so that answer is
// never reported as shown.
const worthShowing = (found: Shared) => found.shared > 0 || found.repos.length > 0;

// The page asks once it shows the library of someone else's stars to a signed-in viewer, and never on the viewer's own
// page or signed out, where this is undefined.
export const useNewToYou = (audience: Audience, visible: boolean): NewToYouState | undefined => {
  const login = audience.by === "signed-in" ? audience.owner.login : undefined;
  const [answer, setAnswer] = useState<{ readonly login: string; readonly state: NewToYouState }>();
  const asked = useRef<string | undefined>(undefined);
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (login === undefined || !visible || asked.current === login) return;
    asked.current = login;
    api()
      .newToYou({ login, limit: listed })
      .then(
        (found): NewToYouState =>
          found.shared === null ? { kind: "unsynced" } : { kind: "found", found: { ...found, shared: found.shared } },
        (): NewToYouState => ({ kind: "failed" }),
      )
      .then((state) => setAnswer({ login, state }));
  }, [login, visible]);
  const state: NewToYouState | undefined =
    login === undefined ? undefined : answer?.login === login ? answer.state : { kind: "asking" };
  useEffect(() => {
    if (state?.kind !== "found" || !worthShowing(state.found) || !visible || reported.current === login) return;
    reported.current = login;
    capture("new_to_you_shown", {
      shared: state.found.shared,
      repos: Math.min(state.found.repos.length, firstShown),
    });
  }, [state, visible, login]);
  return state;
};
