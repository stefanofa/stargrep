import { createFileRoute, notFound } from "@tanstack/react-router";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage } from "../lib/load-page.ts";
import { githubLogin, validateParams } from "../lib/search-params.ts";

export const Route = createFileRoute("/$login")({
  validateSearch: validateParams,
  beforeLoad: ({ params }) => {
    if (!githubLogin.test(params.login)) throw notFound();
  },
  loader: async ({ params, parentMatchPromise }) =>
    loadPage({ login: params.login }, (await parentMatchPromise).loaderData),
  component: Owner,
});

function Owner() {
  return <StarsPage data={Route.useLoaderData()} />;
}
