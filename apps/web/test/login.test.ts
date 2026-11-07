import { expect, test } from "bun:test";
import { GitHubLogin } from "@stargrep/api/contract";
import { isGitHubLogin, loginKey } from "@stargrep/github/login";
import { Login } from "@stargrep/github/schemas";
import * as Schema from "effect/Schema";

const apiAccepts = Schema.is(GitHubLogin);

test("the API and browser accept existing GitHub logins and agree on input boundaries", () => {
  for (const [login, valid] of [
    ["a", true],
    ["0", true],
    ["Octo-Cat", true],
    ["a".repeat(39), true],
    ["", false],
    ["a".repeat(40), false],
    ["-octocat", false],
    ["octocat-", true],
    ["octo--cat", true],
    ["Nek-", true],
    ["john--", true],
    ["foo--bar", true],
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
    expect([login, apiAccepts(login), isGitHubLogin(login)]).toEqual([login, valid, valid]);
  }
  expect(loginKey("Octo-Cat")).toBe("octo-cat");
});

test("logins read from GitHub or storage are not subject to the input syntax rule", () => {
  const accepts = Schema.is(Login);
  for (const login of ["Nek-", "john--", "foo--bar", "managed_user"]) expect(accepts(login)).toBe(true);
  expect(accepts("")).toBe(false);
});
