import { createFileRoute, notFound } from "@tanstack/react-router";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage, revealHead } from "../lib/load-page.ts";
import { githubLogin, validateParams } from "../lib/search-params.ts";

// Any login's stars at /@login. A login that shares its name with a stargrep path, such as /api, lives only here.
export const Route = createFileRoute("/@{$login}")({
  validateSearch: validateParams,
  beforeLoad: ({ params }) => {
    if (!githubLogin.test(params.login)) throw notFound();
  },
  loader: async ({ params, parentMatchPromise }) =>
    loadPage({ login: params.login }, (await parentMatchPromise).loaderData),
  head: revealHead,
  component: Owner,
});

function Owner() {
  return <StarsPage data={Route.useLoaderData()} />;
}
