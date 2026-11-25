import { createFileRoute, lazyRouteComponent, notFound, redirect } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";
import { canonicalLinks, pagePath, previewMeta, siteTitle, topicImage } from "../lib/preview.ts";
import { topicPattern } from "../lib/topic-path.ts";

const loadTopic = () => import("../components/topic-page.tsx");

// A GitHub topic's page. Another spelling, such as next-js or NextJS, leads to the topic's own address, and a topic
// without a page answers 404. Its own chunk, so the landing and the stars engine carry none of it.
export const Route = createFileRoute("/topics/$topic")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { q?: string; repo?: string } => ({
    ...(typeof search.q === "string" && search.q.trim() !== "" ? { q: search.q.slice(0, 500) } : {}),
    ...(typeof search.repo === "string" && search.repo !== "" ? { repo: search.repo.slice(0, 200) } : {}),
  }),
  beforeLoad: ({ params: { topic }, search }) => {
    const lower = topic.toLowerCase();
    if (lower !== topic) throw redirect({ to: "/topics/$topic", params: { topic: lower }, search, statusCode: 301 });
    if (!topicPattern.test(topic)) throw notFound();
  },
  loader: async ({ params: { topic }, parentMatchPromise }) => {
    const session = (await parentMatchPromise).loaderData;
    if (session === undefined) throw new Error("no session");
    const found = await (await loadTopic()).loadTopic(topic);
    if (found.kind === "missing") throw notFound();
    if (found.kind === "elsewhere")
      throw redirect({ to: "/topics/$topic", params: { topic: found.topic }, statusCode: 301 });
    return { site: session.site, topic: found.topic };
  },
  head: ({ loaderData, match }) => {
    if (loaderData === undefined) return {};
    const { topic, site } = loaderData;
    const path = `/topics/${topic.topic}`;
    const q = match.search.q;
    const top = [...(topic.home === null ? [] : [topic.home]), ...topic.core]
      .slice(0, 3)
      .map((repo) => `${repo.owner}/${repo.name}`);
    const description = q
      ? `Searching ${topic.topic} repos for "${q}" on stargrep.`
      : `${topic.topic} repos ranked by how many people on stargrep star them, such as ${top.join(", ")}. Search all ${topic.repos.toLocaleString("en")} in plain words.`;
    return {
      meta: previewMeta(site, {
        title: `${topic.topic} repos developers actually star · ${siteTitle}`,
        description,
        path: pagePath(path, q),
        image: topicImage(topic.topic, q),
      }),
      links: canonicalLinks(site, path),
    };
  },
  component: lazyRouteComponent(loadTopic, "TopicPage"),
  notFoundComponent: lazyRouteComponent(loadTopic, "TopicMissing"),
  errorComponent: Failure,
});
