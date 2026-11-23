import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { loadEngine } from "../lib/engine.ts";
import { canonicalLinks, engineLinks, previewMeta, siteTitle } from "../lib/preview.ts";
import type { PeopleSort } from "../lib/rpc.ts";

const path = "/people";
const title = `people · ${siteTitle}`;
const description = "Pick a developer and search their starred GitHub repos in plain words.";
const sorts: ReadonlyArray<PeopleSort> = ["most-like-you", "recently-active"];
const isPeopleSort = (value: unknown): value is PeopleSort => sorts.some((sort) => sort === value);

// The people list, so a visitor who knows no username still has someone to start with. A GitHub user named people lives
// at /@people. The page rides in the engine chunk, as the text pages do.
export const Route = createFileRoute("/people")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { sort?: PeopleSort } =>
    isPeopleSort(search.sort) ? { sort: search.sort } : {},
  loaderDeps: ({ search }) => ({ sort: search.sort }),
  // A signed-in viewer sees the people most like them first, and anyone else who starred something last.
  loader: async ({ deps, parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    const sort = deps.sort ?? (session.viewer === null ? "recently-active" : "most-like-you");
    const engine = await loadEngine();
    return { site: session.site, first: await engine.firstPeople(sort) };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description, path }),
    links: [...canonicalLinks(loaderData?.site, path), ...engineLinks(loaderData?.site)],
  }),
  component: lazyRouteComponent(loadEngine, "PeoplePage"),
  errorComponent: Failure,
});
