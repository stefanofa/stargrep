import { apiKeyName } from "@stargrep/ai/gateway";
import type { AppCredentials } from "@stargrep/github/app-jwt";
import { BudgetShare } from "@stargrep/github/schemas";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { githubClientIdName, optionalSecret, requiredSecret } from "./config.ts";
import { stageSettings } from "./stage.ts";

export const serverTokenName = "STARGREP_GITHUB_SERVER_TOKEN";

export const ServerTokenKind = Schema.Literals(["app", "pat"]);
export type ServerTokenKind = typeof ServerTokenKind.Type;

export const serverTokenKindFor = (stage: string): Config.Config<ServerTokenKind> =>
  Config.schema(Schema.Literals(["app", "pat", ""]), serverTokenName).pipe(
    Config.withDefault(""),
    Config.map((kind) => (kind === "" ? stageSettings(stage).defaultServerToken : kind)),
  );

// Runtime bindings always carry the kind selected at deploy.
export const serverTokenKind = serverTokenKindFor("");

export const budgetShareName = "GITHUB_BUDGET_SHARE";

// No one else spends the App installation's budget, and the tenth left over covers manual checks and drift between the
// gate's count and GitHub's. A personal token's owner keeps half of theirs for their own tools.
export const kindShare = (kind: ServerTokenKind) => BudgetShare.make(kind === "app" ? 0.9 : 0.5);

const ShareFromString = Schema.NumberFromString.pipe(Schema.decodeTo(BudgetShare));

// The share the gate reads, bound by the deploy.
export const budgetShare = serverTokenKind.pipe(
  Config.flatMap((kind) => Config.schema(ShareFromString, budgetShareName).pipe(Config.withDefault(kindShare(kind)))),
);

// Prod takes its token's share, so a share set to test a preview stage cannot change prod's budget.
export const stageBudgetShare = (stage: string, kind: ServerTokenKind) => {
  const share = kindShare(kind);
  const schema = stageSettings(stage).production
    ? ShareFromString.check(
        Schema.makeFilter((value) => value === share || `prod takes a GitHub budget share of ${share} with ${kind}`),
      )
    : ShareFromString;
  return Config.schema(schema, budgetShareName).pipe(Config.withDefault(share));
};

export const serverTokenPolicy = (stage: string) =>
  serverTokenKindFor(stage).pipe(
    Config.flatMap((kind) => Config.all({ kind: Config.succeed(kind), share: stageBudgetShare(stage, kind) })),
  );

export const githubTokenName = "STARGREP_GITHUB_TOKEN";
export const githubAppKeyName = "STARGREP_GITHUB_APP_PRIVATE_KEY";
const appClientId = Config.schema(Schema.NonEmptyString, githubClientIdName);
export const githubToken = optionalSecret(githubTokenName);

export type ServerToken =
  | { readonly _tag: "App"; readonly credentials: AppCredentials }
  | { readonly _tag: "Pat"; readonly token: Redacted.Redacted<string> };

export const serverToken = (kind: ServerTokenKind): Config.Config<Option.Option<ServerToken>> =>
  kind === "app"
    ? Config.all({ privateKey: requiredSecret(githubAppKeyName), clientId: appClientId }).pipe(
        Config.map((credentials) => Option.some<ServerToken>({ _tag: "App", credentials })),
      )
    : githubToken.pipe(Config.map(Option.map((token): ServerToken => ({ _tag: "Pat", token }))));

export const serverTokenConfig = serverTokenKind.pipe(
  Config.flatMap((kind) =>
    Config.all({
      kind: Config.succeed(kind),
      credential: serverToken(kind),
      share: budgetShare,
    }),
  ),
);

export const requireStageSecrets = Effect.fn("requireStageSecrets")(function* (stage: string, kind: ServerTokenKind) {
  if (stageSettings(stage).production) {
    yield* requiredSecret(apiKeyName);
    yield* kind === "app"
      ? Effect.asVoid(Config.all([requiredSecret(githubAppKeyName), appClientId]))
      : requiredSecret(githubTokenName);
    return;
  }
  if (Option.isSome(yield* optionalSecret(githubAppKeyName)))
    return yield* Effect.die(`${githubAppKeyName} belongs to prod only, and ${stage} must not read it`);
});
