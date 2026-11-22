import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadEngine } from "../lib/engine.ts";
import { canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";

const path = "/topics";
const title = `topics · ${siteTitle}`;
const description = "GitHub topics ranked by what developers actually star, each searchable in plain words.";
const loadTopics = () => import("../components/topics-page.tsx");

// Every topic with a page. Its own chunk, so the landing and the stars engine carry none of it.
export const Route = createFileRoute("/topics/")({
  codeSplitGroupings: [],
  loader: async ({ parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    return { site: session.site, first: await (await loadTopics()).firstTopics() };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description, path }),
    links: canonicalLinks(loaderData?.site, path),
  }),
  component: lazyRouteComponent(loadTopics, "TopicsPage"),
  errorComponent: lazyRouteComponent(loadEngine, "Failure"),
});
