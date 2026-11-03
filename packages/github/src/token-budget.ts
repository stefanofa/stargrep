import type { BudgetShare, RateLimit } from "./schemas.ts";

export interface Window {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly floor: number;
}

export interface Budget {
  readonly share: BudgetShare;
  readonly windows: Readonly<Record<string, Window>>;
}

export type Decision = { readonly _tag: "Allowed" } | { readonly _tag: "Exhausted"; readonly resetAt: number };

const allowed: Decision = { _tag: "Allowed" };

export const make = (share: BudgetShare): Budget => ({ share, windows: {} });

export const resourceOf = (url: string): string => (new URL(url).pathname === "/graphql" ? "graphql" : "core");

export const check = (budget: Budget, resource: string, now: number): Decision => {
  const window = budget.windows[resource];
  if (window === undefined || now >= window.resetAt || window.remaining > window.floor) return allowed;
  return { _tag: "Exhausted", resetAt: window.resetAt };
};

// A window starts on the first response that carries a new reset time. Its
// floor is the part of that response's remaining budget that stays unspent.
export const observe = (budget: Budget, rateLimit: RateLimit): Budget => {
  const current = budget.windows[rateLimit.resource];
  const floor =
    current !== undefined && current.resetAt === rateLimit.resetAt
      ? current.floor
      : rateLimit.remaining - Math.floor(rateLimit.remaining * budget.share);
  return {
    ...budget,
    windows: {
      ...budget.windows,
      [rateLimit.resource]: {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        resetAt: rateLimit.resetAt,
        floor,
      },
    },
  };
};
