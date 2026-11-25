import { createFileRoute } from "@tanstack/react-router";
import { tabRoute } from "../lib/tab-route.ts";

// What a login stars and when, as charts. Its own chunk, as topic pages are, so the landing and the stars engine carry
// none of it.
export const Route = createFileRoute("/@{$login}_/taste")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { months?: "all" } =>
    search.months === "all" ? { months: "all" } : {},
  ...tabRoute(() => import("../components/taste-page.tsx")),
});
