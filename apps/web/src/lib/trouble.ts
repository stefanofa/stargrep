import type { WireCode } from "@stargrep/api/errors";
import { cookieValue, setCookie } from "./cookies.ts";
import { wireCode } from "./rpc.ts";
import { sameLogin } from "./whose.ts";

export type Refusal = "missing" | "busy" | "limited" | "unavailable";

// What triggerSync refuses with, and what the page then shows instead of progress. Any other failure to start a sync,
// such as GitHub being out of reach, is shown as unavailable and offered again.
const refusals: Partial<Record<WireCode, Refusal>> = {
  LOGIN_NOT_FOUND: "missing",
  SYNC_BUSY: "busy",
  TOO_MANY_REQUESTS: "limited",
};

const allRefusals: ReadonlyArray<Refusal> = ["missing", "busy", "limited", "unavailable"];

// Everything that keeps a stars page from showing progress or stars: a refused import, or a library that didn't load.
export type Trouble = Refusal | "load-limited" | "load-failed";

const isRefusal = (value: string): value is Refusal => allRefusals.some((refusal) => refusal === value);

export const refusalOf = (cause: unknown): Refusal => {
  const code = wireCode(cause);
  return (code === undefined ? undefined : refusals[code]) ?? "unavailable";
};

export const libraryTrouble = (failure: unknown): Trouble =>
  wireCode(failure) === "TOO_MANY_REQUESTS" ? "load-limited" : "load-failed";

// A refused import is remembered for a while in a cookie, so a reload shows the refusal again, from the server, instead
// of asking GitHub again. Trying again, or an import that starts, forgets it.
const remembered = "stargrep-refused";
const remembering = 600;

export const rememberedRefusal = (cookies: string | null, login: string): Refusal | undefined => {
  const value = cookieValue(cookies, remembered);
  if (value === undefined) return undefined;
  const [who, refusal] = value.split(":");
  return who !== undefined && sameLogin(who, login) && refusal !== undefined && isRefusal(refusal)
    ? refusal
    : undefined;
};

export const rememberRefusal = (login: string, refusal: Refusal) =>
  setCookie(remembered, `${login}:${refusal}`, remembering);

export const forgetRefusal = (login: string) => {
  if (rememberedRefusal(document.cookie, login) !== undefined) setCookie(remembered, "", 0);
};
