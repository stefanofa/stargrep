import { createFileRoute } from "@tanstack/react-router";
import { tabRoute } from "../lib/tab-route.ts";
import { topicPattern } from "../lib/topic-examples.ts";

// The people with stars like a login's, into one of its topics with ?topic=. Its own chunk, as the taste tab is.
export const Route = createFileRoute("/@{$login}_/people")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { topic?: string } =>
    typeof search.topic === "string" && topicPattern.test(search.topic) ? { topic: search.topic } : {},
  loaderDeps: ({ search }) => search,
  ...tabRoute(() => import("../components/people-tab.tsx")),
});
