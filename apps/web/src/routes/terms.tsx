import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadTextPages } from "../lib/text-pages.ts";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [{ title: "terms · stargrep" }, { name: "description", content: "The terms for using stargrep." }],
  }),
  codeSplitGroupings: [],
  component: lazyRouteComponent(loadTextPages, "TermsPage"),
});
