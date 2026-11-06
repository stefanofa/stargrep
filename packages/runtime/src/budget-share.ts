import { BudgetShare } from "@stargrep/github/schemas";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export const budgetShareName = "GITHUB_BUDGET_SHARE";

const defaultShare = BudgetShare.make(0.5);

const ShareFromString = Schema.NumberFromString.pipe(Schema.decodeTo(BudgetShare));

// Prod keeps the default, so a share lowered to test a preview stage cannot shrink prod's budget.
const ProdShareFromString = ShareFromString.check(
  Schema.makeFilter((share) => share === defaultShare || `prod takes a GitHub budget share of ${defaultShare}`),
);

const shareConfig = (schema: typeof ShareFromString) =>
  Config.schema(schema, budgetShareName).pipe(Config.withDefault(defaultShare));

export const budgetShare = shareConfig(ShareFromString);

export const stageBudgetShare = (stage: string) =>
  shareConfig(stage === "prod" ? ProdShareFromString : ShareFromString);
