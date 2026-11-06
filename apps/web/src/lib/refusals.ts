import { wireCode } from "./rpc.ts";

// What triggerSync refuses with, and what the page then shows instead of progress.
const refusals = { LOGIN_NOT_FOUND: "missing", SYNC_BUSY: "busy", TOO_MANY_REQUESTS: "limited" } as const;

// Any other failure to start a sync, such as GitHub being out of reach, is shown as unavailable and offered again.
export type Refusal = (typeof refusals)[keyof typeof refusals] | "unavailable";

export const refusalOf = (cause: unknown): Refusal => {
  const code = wireCode(cause);
  return code !== undefined && code in refusals ? refusals[code as keyof typeof refusals] : "unavailable";
};
