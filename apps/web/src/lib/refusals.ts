import { wireCode } from "./rpc.ts";

// What triggerSync refuses with, and what the page then shows instead of progress.
const refusals = { LOGIN_NOT_FOUND: "missing", SYNC_BUSY: "busy", TOO_MANY_REQUESTS: "limited" } as const;

export type Refusal = (typeof refusals)[keyof typeof refusals];

export const refusalOf = (cause: unknown): Refusal | undefined => {
  const code = wireCode(cause);
  return code !== undefined && code in refusals ? refusals[code as keyof typeof refusals] : undefined;
};
