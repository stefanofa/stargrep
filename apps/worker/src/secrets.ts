import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const githubToken = Config.Redacted("STARGREP_GITHUB_TOKEN");
export const aiGatewayKey = Config.Redacted("AI_GATEWAY_API_KEY");

export const requireStageSecrets = (stage: string) =>
  stage === "prod" ? Effect.asVoid(Effect.all([githubToken, aiGatewayKey])) : Effect.void;
