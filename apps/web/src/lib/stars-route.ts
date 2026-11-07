import { isGitHubLogin } from "@stargrep/github/login";
import { notFound, redirect } from "@tanstack/react-router";
import { StarsRoute } from "../components/stars-page.tsx";
import { loadPage, pageHead } from "./load-page.ts";
import type { Session } from "./page-data.ts";
import { type Params, reservedLogin, validateParams } from "./search-params.ts";

interface Load {
  readonly params: { readonly login?: string };
  readonly parentMatchPromise: Promise<{ readonly loaderData?: Session | undefined }>;
}

// What every stars page shares: / for the viewer or the demo, and /{login} and /@{login} for anyone. A login named like
// a stargrep path, such as api, lives at /@login. Each route spreads these into its own object, since the route tree
// writes the route's id and path into its options.
export const starsRoute = {
  validateSearch: validateParams,
  beforeLoad: ({
    params: { login },
    search,
    location,
  }: {
    params: { login?: string };
    search: Params;
    location: { pathname: string };
  }) => {
    if (login === undefined) return;
    if (!isGitHubLogin(login)) throw notFound();
    if (reservedLogin(login) && !location.pathname.startsWith("/@"))
      throw redirect({ to: "/@{$login}", params: { login }, search, replace: true });
  },
  loader: async ({ params: { login }, parentMatchPromise }: Load) =>
    loadPage({ login }, (await parentMatchPromise).loaderData),
  head: pageHead,
  component: StarsRoute,
};
