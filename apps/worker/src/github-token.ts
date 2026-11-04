import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const githubToken = Config.Redacted("STARGREP_GITHUB_TOKEN");

// Prod cannot sync without a token. Other stages deploy without one, and every GitHub call there fails
// with GitHubTokenMissing.
export const requireGitHubToken = (stage: string) => (stage === "prod" ? Effect.asVoid(githubToken) : Effect.void);
