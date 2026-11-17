import { createFileRoute } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage, pageHead } from "../lib/load-page.ts";
import { validateParams } from "../lib/search-params.ts";
import { guardLogin } from "../lib/stars-route.ts";

// The viewer's or the demo's stars at /, and anyone's at /{login}.
export const Route = createFileRoute("/{-$login}")({
  // The page hydrates on the server's HTML without waiting for a route chunk, and lib/engine.ts splits the engine
  // off on its own terms, so the router splits nothing here.
  codeSplitGroupings: [],
  validateSearch: validateParams,
  beforeLoad: ({ params: { login }, search, location }) => {
    if (login !== undefined) guardLogin(login, search, location.pathname);
  },
  loader: async ({ params: { login }, parentMatchPromise }) =>
    loadPage({ login }, (await parentMatchPromise).loaderData),
  head: ({ loaderData, params, match }) =>
    pageHead(loaderData, params.login === undefined, { pathname: match.pathname, query: match.search.q }),
  component: function Stars() {
    return <StarsPage data={Route.useLoaderData()} error={Route.useSearch().error} />;
  },
  // A route without its own error component falls back to TanStack's, not the root's.
  errorComponent: Failure,
});
