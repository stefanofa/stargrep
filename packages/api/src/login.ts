import { githubLogin, isGitHubLogin } from "@stargrep/github/login";
import * as Schema from "effect/Schema";

export const GitHubLogin = Schema.String.check(
  Schema.makeFilter(isGitHubLogin, {
    expected: "a GitHub login",
    toJsonSchema: () => ({ pattern: githubLogin.source }),
  }),
)
  .pipe(Schema.brand("Login"))
  .annotate({
    description: "A GitHub login, such as octocat.",
  });
