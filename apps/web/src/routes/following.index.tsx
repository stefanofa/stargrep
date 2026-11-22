import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";

const loadFollowing = () => import("../components/following-page.tsx");

const path = "/following";
const title = `following · ${siteTitle}`;
const description = "See the GitHub repos the developers you follow starred lately.";

// What the people a signed-in viewer follows starred lately. Its own chunk, as topic pages are, so the landing and the
// stars engine carry none of it. A GitHub user named following lives at /@following.
export const Route = createFileRoute("/following/")({
  codeSplitGroupings: [],
  loader: async ({ parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    const page = await loadFollowing();
    return { site: session.site, data: await page.loadFollowing(session.viewer !== null) };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description, path }),
    links: canonicalLinks(loaderData?.site, path),
  }),
  pendingComponent: lazyRouteComponent(loadFollowing, "FollowingLoading"),
  component: lazyRouteComponent(loadFollowing, "FollowingPage"),
  errorComponent: Failure,
});
