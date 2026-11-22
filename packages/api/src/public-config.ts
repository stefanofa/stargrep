import * as Config from "effect/Config";
import type { PublicConfig } from "./contract.ts";
import { GitHubLogin } from "./login.ts";

type DemoLogin = PublicConfig["demoLogin"];

// The people the landing and the account picker offer first. Each is on the people list whatever the rule says, once
// their stars are synced, and the nightly refresh reads this list. This file imports no oRPC, so the main Worker can
// read it.
export const curated: PublicConfig["curated"] = [
  "t3dotgg",
  "karpathy",
  "simonw",
  "antfu",
  "sindresorhus",
  "gaearon",
  "kentcdodds",
  "steipete",
].map((login) => GitHubLogin.make(login));

// The demo is one setting: STARGREP_DEMO_LOGIN, or this default. The query and examples suit this account's stars, so
// they change with it.
const withDemo = (demoLogin: DemoLogin): PublicConfig => ({
  demoLogin,
  demoQuery: "let an ai agent control my iphone",
  examples: ["postgres for ai agents", "a terminal in the browser", "local voice dictation"],
  featured: [demoLogin],
  curated,
});

export const defaultPublicConfig = withDemo(GitHubLogin.make("stefanofa"));

export const demoLoginName = "STARGREP_DEMO_LOGIN";

export const publicConfig: Config.Config<PublicConfig> = Config.schema(GitHubLogin, demoLoginName).pipe(
  Config.map(withDemo),
  Config.withDefault(defaultPublicConfig),
);
