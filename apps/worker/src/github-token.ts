import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const githubToken = Config.Redacted("STARGREP_GITHUB_TOKEN");

export const requireGitHubToken = (stage: string) => (stage === "prod" ? Effect.asVoid(githubToken) : Effect.void);
