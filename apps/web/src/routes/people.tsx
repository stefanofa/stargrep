import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";
import type { PeopleSort } from "../lib/rpc.ts";
import { topicSearch } from "../lib/topic-path.ts";

const path = "/people";
const title = `people · ${siteTitle}`;
const description = "Pick a developer and search their starred GitHub repos in plain words.";
const sorts: ReadonlyArray<PeopleSort> = ["most-like-you", "recently-active"];
const isPeopleSort = (value: unknown): value is PeopleSort => sorts.some((sort) => sort === value);
const loadPeople = () => import("../components/discover-pages.ts");

// Discover's people segment, in an order with ?sort= and into a topic with ?topic=. A GitHub user named people lives at
// /@people. It shares discover's chunk with topics, so the landing and the stars engine carry none of it.
export const Route = createFileRoute("/people")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { sort?: PeopleSort | undefined; topic?: string | undefined } => ({
    ...(isPeopleSort(search.sort) ? { sort: search.sort } : {}),
    ...topicSearch(search),
  }),
  loaderDeps: ({ search }) => search,
  // A signed-in viewer sees the people most like them first, and anyone else who starred something last.
  loader: async ({ deps, parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    const asked = {
      sort: deps.sort ?? (session.viewer === null ? "recently-active" : "most-like-you"),
      topic: deps.topic,
    } as const;
    return { site: session.site, asked, first: await (await loadPeople()).firstPeople(asked) };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description, path }),
    links: canonicalLinks(loaderData?.site, path),
  }),
  component: lazyRouteComponent(loadPeople, "PeoplePage"),
  errorComponent: Failure,
});
