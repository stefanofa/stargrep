import { createFileRoute } from "@tanstack/react-router";
import { StarsPage } from "../components/stars-page.tsx";
import { loadPage } from "../lib/load-page.ts";
import { validateParams } from "../lib/search-params.ts";

export const Route = createFileRoute("/")({
  validateSearch: validateParams,
  loader: async ({ parentMatchPromise }) => loadPage({}, (await parentMatchPromise).loaderData),
  component: Home,
});

function Home() {
  return <StarsPage data={Route.useLoaderData()} error={Route.useSearch().error} />;
}
