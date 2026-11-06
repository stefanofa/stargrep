import { BudgetShare } from "@stargrep/github/schemas";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import type { ServerTokenKind } from "./server-token.ts";

export const budgetShareName = "GITHUB_BUDGET_SHARE";

// No one else spends the App installation's budget, and the tenth left over covers manual checks and drift between the
// gate's count and GitHub's. A personal token's owner keeps half of theirs for their own tools.
export const kindShare = (kind: ServerTokenKind) => BudgetShare.make(kind === "app" ? 0.9 : 0.5);

const ShareFromString = Schema.NumberFromString.pipe(Schema.decodeTo(BudgetShare));

// The share the gate reads, bound by the deploy.
export const budgetShare = Config.schema(ShareFromString, budgetShareName).pipe(Config.withDefault(kindShare("pat")));

// Prod takes its token's share, so a share set to test a preview stage cannot change prod's budget.
export const stageBudgetShare = (stage: string, kind: ServerTokenKind) => {
  const share = kindShare(kind);
  const schema =
    stage === "prod"
      ? ShareFromString.check(
          Schema.makeFilter((value) => value === share || `prod takes a GitHub budget share of ${share} with ${kind}`),
        )
      : ShareFromString;
  return Config.schema(schema, budgetShareName).pipe(Config.withDefault(share));
};
