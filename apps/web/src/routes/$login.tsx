import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage, revealHead } from "../lib/load-page.ts";
import { githubLogin, reservedLogin, validateParams } from "../lib/search-params.ts";

export const Route = createFileRoute("/$login")({
  validateSearch: validateParams,
  beforeLoad: ({ params, search }) => {
    if (!githubLogin.test(params.login)) throw notFound();
    if (reservedLogin(params.login)) throw redirect({ to: "/@{$login}", params, search, replace: true });
  },
  loader: async ({ params, parentMatchPromise }) =>
    loadPage({ login: params.login }, (await parentMatchPromise).loaderData),
  head: revealHead,
  component: Owner,
});

function Owner() {
  return <StarsPage data={Route.useLoaderData()} />;
}
