import { createFileRoute } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage, pageHead } from "../lib/load-page.ts";
import { validateParams } from "../lib/search-params.ts";
import { guardLogin } from "../lib/stars-route.ts";

// Any login's stars at /@login, the only address for a login named like a stargrep path.
export const Route = createFileRoute("/@{$login}")({
  codeSplitGroupings: [],
  validateSearch: validateParams,
  beforeLoad: ({ params: { login }, search, location }) => guardLogin(login, search, location.pathname),
  loader: async ({ params: { login }, parentMatchPromise }) =>
    loadPage({ login }, (await parentMatchPromise).loaderData),
  head: ({ loaderData, match }) => pageHead(loaderData, { pathname: match.pathname, query: match.search.q }),
  component: function Stars() {
    return <StarsPage data={Route.useLoaderData()} error={Route.useSearch().error} />;
  },
  errorComponent: Failure,
});
