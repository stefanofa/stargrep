import { createFileRoute } from "@tanstack/react-router";
import { tabRoute } from "../lib/tab-route.ts";
import { topicSearch } from "../lib/topic-path.ts";

// The people with stars like a login's, into one of its topics with ?topic=. Its own chunk, as the taste tab is.
export const Route = createFileRoute("/@{$login}_/people")({
  codeSplitGroupings: [],
  validateSearch: topicSearch,
  loaderDeps: ({ search }) => search,
  ...tabRoute(() => import("../components/people-tab.tsx")),
});
