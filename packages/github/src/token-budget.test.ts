import { describe, expect, test } from "bun:test";
import type { BudgetShare } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";

const rateLimit = (remaining: number, resetAt = 3_600_000, resource = "core") => ({
  resource,
  limit: 5000,
  remaining,
  resetAt,
});

describe("TokenBudget", () => {
  test("allows a resource it has not seen yet", () => {
    expect(TokenBudget.check(TokenBudget.make(0.5 as BudgetShare), "core", 0)._tag).toBe("Allowed");
  });

  test("stops once the remaining budget reaches the unspent part", () => {
    let budget = TokenBudget.observe(TokenBudget.make(0.01 as BudgetShare), rateLimit(4900));
    expect(
      TokenBudget.reserveOf(budget.windows.core ?? { limit: 0, remaining: 0, resetAt: 0, openedWith: 0 }, budget.share),
    ).toBe(4851);
    budget = TokenBudget.observe(budget, rateLimit(4852));
    expect(TokenBudget.check(budget, "core", 0)._tag).toBe("Allowed");
    budget = TokenBudget.observe(budget, rateLimit(4851));
    expect(TokenBudget.check(budget, "core", 0)).toEqual({ _tag: "Exhausted", resetAt: 3_600_000 });
  });

  test("keeps the reserve within a window and resets it with the next window", () => {
    let budget = TokenBudget.observe(TokenBudget.make(0.5 as BudgetShare), rateLimit(1000));
    budget = TokenBudget.observe(budget, rateLimit(500));
    expect(TokenBudget.check(budget, "core", 0)._tag).toBe("Exhausted");
    expect(TokenBudget.check(budget, "core", 3_600_000)._tag).toBe("Allowed");
    budget = TokenBudget.observe(budget, rateLimit(4999, 7_200_000));
    expect(budget.windows.core?.openedWith).toBe(4999);
    expect(TokenBudget.check(TokenBudget.observe(budget, rateLimit(2500, 7_200_000)), "core", 3_600_000)._tag).toBe(
      "Exhausted",
    );
    expect(TokenBudget.check(budget, "core", 3_600_000)._tag).toBe("Allowed");
  });

  test("tracks each resource on its own", () => {
    let budget = TokenBudget.observe(TokenBudget.make(0.5 as BudgetShare), rateLimit(10));
    budget = TokenBudget.observe(budget, rateLimit(5));
    expect(TokenBudget.check(budget, "core", 0)._tag).toBe("Exhausted");
    expect(TokenBudget.check(budget, "graphql", 0)._tag).toBe("Allowed");
  });

  test("takes the share from the budget, not from the window, so a new share applies to a stored window", () => {
    let half = TokenBudget.observe(TokenBudget.make(0.5 as BudgetShare), rateLimit(1000));
    half = TokenBudget.observe(half, rateLimit(400));
    expect(TokenBudget.check(half, "core", 0)._tag).toBe("Exhausted");
    const stored = TokenBudget.decodeWindows(JSON.parse(JSON.stringify(half.windows)));
    expect(stored._tag).toBe("Some");
    const widened = TokenBudget.make(0.7 as BudgetShare, stored._tag === "Some" ? stored.value : {});
    expect(widened.windows).toEqual(half.windows);
    expect(TokenBudget.check(widened, "core", 0)._tag).toBe("Allowed");
  });

  test("maps the GraphQL endpoint to its own resource", () => {
    expect(TokenBudget.resourceOf("/graphql")).toBe("graphql");
    expect(TokenBudget.resourceOf("/users/octocat/starred")).toBe("core");
  });
});
