import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadEngine } from "../lib/engine.ts";
import { canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";

const path = "/people";
const title = `people · ${siteTitle}`;
const description = "Pick a developer and search their starred GitHub repos in plain words.";

// The people list, so a visitor who knows no username still has someone to start with. A GitHub user named people lives
// at /@people. The page rides in the engine chunk, as the text pages do.
export const Route = createFileRoute("/people")({
  codeSplitGroupings: [],
  loader: async ({ parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    const engine = await loadEngine();
    return { site: session.site, first: await engine.firstPeople("recently-active") };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description, path }),
    links: canonicalLinks(loaderData?.site, path),
  }),
  component: lazyRouteComponent(loadEngine, "PeoplePage"),
  errorComponent: lazyRouteComponent(loadEngine, "Failure"),
});
