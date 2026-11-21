import { useEffect, useRef, useState } from "react";
import { capture } from "./analytics.ts";
import type { Audience } from "./audience.ts";
import { api, type NewToYou } from "./rpc.ts";

// The tile lists this many at first and the rest of the answer once opened.
export const firstShown = 8;
export const listed = 48;

export type Shared = NewToYou & { readonly shared: number };

const worthShowing = (found: NewToYou): found is Shared =>
  found.shared !== null && (found.shared > 0 || found.repos.length > 0);

// What a signed-in viewer has in common with someone else's stars. The page asks once it shows the library, and shows
// nothing on the viewer's own page, signed out, before the viewer's own stars have synced, when the two accounts have
// nothing to say about each other, or when the API refuses.
export const useNewToYou = (audience: Audience, visible: boolean): Shared | undefined => {
  const login = audience.by === "signed-in" ? audience.owner.login : undefined;
  const [answer, setAnswer] = useState<{ readonly login: string; readonly found: NewToYou }>();
  const asked = useRef<string | undefined>(undefined);
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (login === undefined || !visible || asked.current === login) return;
    asked.current = login;
    api()
      .newToYou({ login, limit: listed })
      .then(
        (found) => setAnswer({ login, found }),
        () => {},
      );
  }, [login, visible]);
  const found = answer !== undefined && answer.login === login && worthShowing(answer.found) ? answer.found : undefined;
  useEffect(() => {
    if (found === undefined || !visible || reported.current === login) return;
    reported.current = login;
    capture("new_to_you_shown", { shared: found.shared, repos: Math.min(found.repos.length, firstShown) });
  }, [found, visible, login]);
  return found;
};
