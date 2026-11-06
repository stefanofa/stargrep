import type { PipPose, StatusIcon } from "@stargrep/ui";
import { wireCode } from "./rpc.ts";

// What triggerSync refuses with, and what the page then shows instead of progress.
const refusals = { LOGIN_NOT_FOUND: "missing", SYNC_BUSY: "busy", TOO_MANY_REQUESTS: "limited" } as const;

// Any other failure to start a sync, such as GitHub being out of reach, is shown as unavailable and offered again.
export type Refusal = (typeof refusals)[keyof typeof refusals] | "unavailable";

// Everything that keeps a stars page from showing progress or stars: a refused import, or a library that didn't load.
export type Trouble = Refusal | "load-limited" | "load-failed";

const isRefusal = (value: string): value is Refusal =>
  value === "unavailable" || Object.values(refusals).some((refusal) => refusal === value);

export const refusalOf = (cause: unknown): Refusal => {
  const code = wireCode(cause);
  return code !== undefined && code in refusals ? refusals[code as keyof typeof refusals] : "unavailable";
};

export const libraryTrouble = (failure: unknown): Trouble =>
  wireCode(failure) === "TOO_MANY_REQUESTS" ? "load-limited" : "load-failed";

export interface TroubleCopy {
  readonly status: { readonly icon: StatusIcon; readonly label: string; readonly detail?: string };
  readonly heading: string;
  readonly detail: string;
  readonly pose: PipPose;
  // What "try again" asks for: the import again, the library again, or nothing, since a login GitHub doesn't know is a
  // dead end.
  readonly retry: "sync" | "library" | null;
}

const breather = { icon: "paused", label: "taking a breather" } as const;

export const troubleCopy = (trouble: Trouble, owner: string, own: boolean): TroubleCopy => {
  const stars = own ? "your stars" : `@${owner}'s stars`;
  switch (trouble) {
    case "missing":
      return {
        status: { icon: "failed", label: "no such github user" },
        heading: `github has no one called @${owner}`,
        detail: "check the spelling, or pick someone else from the pill above.",
        pose: "unsure",
        retry: null,
      };
    case "busy":
      return {
        status: { icon: "paused", label: "the import line is full", detail: "for now" },
        heading: "github's line for new imports is full",
        detail: `stargrep can read ${stars} once there's room. try again in a while.`,
        pose: "unsure",
        retry: "sync",
      };
    case "limited":
      return {
        status: breather,
        heading: "lots of requests from your network",
        detail: "give it a few minutes, then try again. accounts stargrep already knows still work.",
        pose: "unsure",
        retry: "sync",
      };
    case "unavailable":
      return {
        status: { icon: "failed", label: "couldn't reach github" },
        heading: "stargrep couldn't reach github just now",
        detail: `${stars} can import once it answers. try again in a moment.`,
        pose: "unsure",
        retry: "sync",
      };
    case "load-limited":
      return {
        status: breather,
        heading: "lots of requests from your network",
        detail: "give it a minute, then try again.",
        pose: "unsure",
        retry: "library",
      };
    case "load-failed":
      return {
        status: { icon: "failed", label: "couldn't load" },
        heading: `stargrep couldn't load ${stars}`,
        detail: "the library didn't arrive. try again in a moment.",
        pose: "scared",
        retry: "library",
      };
  }
};

// A refused import is remembered for a while in a cookie, so a reload shows the refusal again, from the server, instead
// of asking GitHub again. Trying again, or an import that starts, forgets it.
const remembered = "stargrep-refused";
const remembering = 600;

export const rememberedRefusal = (cookies: string | null, login: string): Refusal | undefined => {
  const value = cookies?.match(new RegExp(`(?:^|;\\s*)${remembered}=([^;]*)`))?.[1];
  if (value === undefined) return undefined;
  const [who, refusal] = decodeURIComponent(value).split(":");
  return who?.toLowerCase() === login.toLowerCase() && refusal !== undefined && isRefusal(refusal)
    ? refusal
    : undefined;
};

const setCookie = (value: string, maxAge: number) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the server reads this cookie when it renders the page, so it can't live in storage.
  document.cookie = `${remembered}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
};

export const rememberRefusal = (login: string, refusal: Refusal) => setCookie(`${login}:${refusal}`, remembering);

export const forgetRefusal = (login: string) => {
  if (rememberedRefusal(document.cookie, login) !== undefined) setCookie("", 0);
};
