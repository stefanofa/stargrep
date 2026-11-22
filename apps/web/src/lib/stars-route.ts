import { isGitHubLogin } from "@stargrep/github/login";
import { notFound, redirect } from "@tanstack/react-router";
import { type Params, reservedLogin } from "./search-params.ts";

// The hero's username field sends this parameter to / when someone submits it before the page hydrates.
export const typedLoginParam = "user";

// The login someone typed, such as " @octocat ", or undefined when GitHub could have no such login.
export const typedLogin = (typed: string) => {
  const login = typed.trim().replace(/^@/, "");
  return isGitHubLogin(login) ? login : undefined;
};

// Where a login's stars live. A login named like a stargrep path, such as api, lives at /@login.
export const loginPage = (login: string) =>
  reservedLogin(login)
    ? { to: "/@{$login}" as const, params: { login } }
    : { to: "/{-$login}" as const, params: { login } };

// The path of loginPage, for a plain link.
export const loginHref = (login: string) => (reservedLogin(login) ? `/@${login}` : `/${login}`);

// A stars page answers only for a GitHub login.
export const guardLogin = (login: string, search: Params, pathname: string) => {
  if (!isGitHubLogin(login)) throw notFound();
  if (reservedLogin(login) && !pathname.startsWith("/@"))
    throw redirect({ to: "/@{$login}", params: { login }, search, replace: true });
};

export const guardHome = (searchStr: string) => {
  const login = typedLogin(new URLSearchParams(searchStr).get(typedLoginParam) ?? "");
  if (login !== undefined) throw redirect({ ...loginPage(login), replace: true });
};
