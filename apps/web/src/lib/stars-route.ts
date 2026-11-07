import { isGitHubLogin } from "@stargrep/github/login";
import { notFound, redirect } from "@tanstack/react-router";
import { type Params, reservedLogin } from "./search-params.ts";

// A stars page answers only for a GitHub login. A login named like a stargrep path, such as api, lives at /@login.
export const guardLogin = (login: string, search: Params, pathname: string) => {
  if (!isGitHubLogin(login)) throw notFound();
  if (reservedLogin(login) && !pathname.startsWith("/@"))
    throw redirect({ to: "/@{$login}", params: { login }, search, replace: true });
};
