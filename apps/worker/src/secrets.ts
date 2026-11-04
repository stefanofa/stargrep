import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const githubTokenName = "STARGREP_GITHUB_TOKEN";
const aiGatewayKeyName = "AI_GATEWAY_API_KEY";

// Actions passes a secret that is not set as an empty string, and the process environment keeps it.
const optional = (name: string) =>
  Config.Redacted(name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")));

const required = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const githubToken = optional(githubTokenName);
export const aiGatewayKey = optional(aiGatewayKeyName);

export const requireStageSecrets = (stage: string) =>
  stage === "prod" ? Effect.asVoid(Effect.all([required(githubTokenName), required(aiGatewayKeyName)])) : Effect.void;
