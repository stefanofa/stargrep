import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { Failure } from "../components/problem-page.tsx";

const loadTaste = () => import("../components/taste-page.tsx");

// What a login stars and when, as charts. Its own chunk, as topic pages are, so the landing and the stars engine carry
// none of it. The loader builds the head too, so the entry holds nothing but this route.
export const Route = createFileRoute("/@{$login}_/taste")({
  codeSplitGroupings: [],
  validateSearch: (search: Record<string, unknown>): { months?: "all" } =>
    search.months === "all" ? { months: "all" } : {},
  loader: async ({ params: { login }, parentMatchPromise }) =>
    (await loadTaste()).loadTaste(login, (await parentMatchPromise).loaderData),
  head: ({ loaderData }) => loaderData?.head ?? {},
  pendingComponent: lazyRouteComponent(loadTaste, "TasteLoading"),
  component: lazyRouteComponent(loadTaste, "TastePage"),
  errorComponent: Failure,
});
