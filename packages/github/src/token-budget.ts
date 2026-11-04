import * as Schema from "effect/Schema";
import type { BudgetShare, RateLimit } from "./schemas.ts";

const Window = Schema.Struct({
  limit: Schema.Int,
  remaining: Schema.Int,
  resetAt: Schema.Int,
  openedWith: Schema.Int,
});
type Window = typeof Window.Type;

export const Windows = Schema.Record(Schema.String, Window);
export type Windows = typeof Windows.Type;

export const decodeWindows = Schema.decodeUnknownOption(Windows);

export interface Budget {
  readonly share: BudgetShare;
  readonly windows: Windows;
}

export type Decision = { readonly _tag: "Allowed" } | { readonly _tag: "Exhausted"; readonly resetAt: number };

const allowed: Decision = { _tag: "Allowed" };

export const make = (share: BudgetShare, windows: Windows = {}): Budget => ({ share, windows });

export const resourceOf = (path: string): string => (path === "/graphql" ? "graphql" : "core");

export const reserveOf = (window: Window, share: BudgetShare) =>
  window.openedWith - Math.floor(window.openedWith * share);

export const check = (budget: Budget, resource: string, now: number): Decision => {
  const window = budget.windows[resource];
  if (window === undefined || now >= window.resetAt || window.remaining > reserveOf(window, budget.share)) {
    return allowed;
  }
  return { _tag: "Exhausted", resetAt: window.resetAt };
};

export const observe = (budget: Budget, rateLimit: RateLimit): Budget => {
  const current = budget.windows[rateLimit.resource];
  const opensWindow = current === undefined || current.resetAt !== rateLimit.resetAt;
  return {
    ...budget,
    windows: {
      ...budget.windows,
      [rateLimit.resource]: {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        resetAt: rateLimit.resetAt,
        openedWith: opensWindow ? rateLimit.remaining : current.openedWith,
      },
    },
  };
};
