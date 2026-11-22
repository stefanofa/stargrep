import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { previewMeta, siteTitle } from "../lib/preview.ts";

const loadFollowing = () => import("../components/following-page.tsx");

const title = `people you follow · ${siteTitle}`;

// The people a signed-in viewer follows, to prune, with the GitHub import on ?pick. Signed out, it leads to /following.
export const Route = createFileRoute("/following/people")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { pick?: true } => (search.pick === true ? { pick: true } : {}),
  loader: async ({ parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    if (session.viewer === null) throw redirect({ to: "/following" });
    const page = await loadFollowing();
    return { site: session.site, people: await page.loadFollowedPeople() };
  },
  head: ({ loaderData }) => ({
    meta: previewMeta(loaderData?.site, { title, description: title, path: "/following/people" }),
  }),
  // The page carries one viewer's follows in its HTML, so no cache may store it.
  headers: () => ({ "cache-control": "private, no-store" }),
  component: lazyRouteComponent(loadFollowing, "FollowingPeoplePage"),
  errorComponent: Failure,
});
