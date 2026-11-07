import { expect, test } from "bun:test";
import { GitHubLogin } from "@stargrep/api/contract";
import { githubLogin, loginKey } from "@stargrep/github/login";
import { Login } from "@stargrep/github/schemas";
import * as Schema from "effect/Schema";

const apiAccepts = Schema.is(GitHubLogin);
const domainAccepts = Schema.is(Login);

test("the API, domain, and browser agree on GitHub login boundaries", () => {
  for (const [login, valid] of [
    ["a", true],
    ["0", true],
    ["Octo-Cat", true],
    ["a".repeat(39), true],
    ["", false],
    ["a".repeat(40), false],
    ["-octocat", false],
    ["octocat-", false],
    ["octo--cat", false],
    ["octo_cat", false],
    ["octo.cat", false],
    ["octocat/else", false],
    ["octocat\n", false],
    ["octocat\r\n", false],
    ["octocat\u2028", false],
    [" octocat", false],
    ["octocat ", false],
    ["café", false],
  ] as const) {
    expect([login, apiAccepts(login), domainAccepts(login), githubLogin.test(login)]).toEqual([
      login,
      valid,
      valid,
      valid,
    ]);
  }
  expect(loginKey("Octo-Cat")).toBe("octo-cat");
});
