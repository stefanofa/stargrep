import * as Config from "effect/Config";
import { GitHubLogin, type PublicConfig } from "./contract.ts";

type DemoLogin = PublicConfig["demoLogin"];

// The demo is one setting: STARGREP_DEMO_LOGIN, or this default. The query and examples suit this account's stars, so
// they change with it.
const withDemo = (demoLogin: DemoLogin): PublicConfig => ({
  demoLogin,
  demoQuery: "let an ai agent control my iphone",
  examples: ["postgres for ai agents", "a terminal in the browser", "local voice dictation"],
  featured: [demoLogin],
});

export const defaultPublicConfig = withDemo(GitHubLogin.make("stefanofa"));

export const demoLoginName = "STARGREP_DEMO_LOGIN";

export const publicConfig: Config.Config<PublicConfig> = Config.schema(GitHubLogin, demoLoginName).pipe(
  Config.map(withDemo),
  Config.withDefault(defaultPublicConfig),
);
