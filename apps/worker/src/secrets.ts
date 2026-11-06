import { apiKeyName } from "@stargrep/ai/gateway";
import { names } from "@stargrep/auth/config";
import type { AppCredentials } from "@stargrep/github/app-jwt";
import { optionalSecret } from "@stargrep/runtime/config";
import type { ServerTokenKind } from "@stargrep/runtime/server-token";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const githubTokenName = "STARGREP_GITHUB_TOKEN";
export const githubAppKeyName = "STARGREP_GITHUB_APP_PRIVATE_KEY";

const required = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);
const appClientId = Config.schema(Schema.NonEmptyString, names.clientId);

export const githubToken = optionalSecret(githubTokenName);

export type ServerToken =
  | { readonly _tag: "App"; readonly credentials: AppCredentials }
  | { readonly _tag: "Pat"; readonly token: Redacted.Redacted<string> };

// Reads only the credential its kind uses, so a Worker binds the App's key or the personal token, never both.
export const serverToken = (kind: ServerTokenKind): Config.Config<Option.Option<ServerToken>> =>
  kind === "app"
    ? Config.all({ privateKey: required(githubAppKeyName), clientId: appClientId }).pipe(
        Config.map((credentials) => Option.some<ServerToken>({ _tag: "App", credentials })),
      )
    : githubToken.pipe(Config.map(Option.map((token): ServerToken => ({ _tag: "Pat", token }))));

// Prod needs the AI key and the credential its kind reads with. The preview environment is readable from every branch,
// so any other stage that sees the App's key refuses to deploy instead of putting it on a Worker.
export const requireStageSecrets = Effect.fn("requireStageSecrets")(function* (stage: string, kind: ServerTokenKind) {
  if (stage === "prod") {
    yield* required(apiKeyName);
    yield* kind === "app"
      ? Effect.asVoid(Config.all([required(githubAppKeyName), appClientId]))
      : required(githubTokenName);
    return;
  }
  if (Option.isSome(yield* optionalSecret(githubAppKeyName))) {
    return yield* Effect.die(`${githubAppKeyName} belongs to prod only, and ${stage} must not read it`);
  }
});
