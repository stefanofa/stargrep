import { apiKeyName } from "@stargrep/ai/gateway";
import { optionalSecret } from "@stargrep/runtime/config";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const githubTokenName = "STARGREP_GITHUB_TOKEN";

const required = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const githubToken = optionalSecret(githubTokenName);

export const requireStageSecrets = (stage: string) =>
  stage === "prod" ? Effect.asVoid(Effect.all([required(githubTokenName), required(apiKeyName)])) : Effect.void;
