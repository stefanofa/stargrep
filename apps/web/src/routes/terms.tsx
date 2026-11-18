import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadEngine } from "../lib/engine.ts";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [{ title: "terms · stargrep" }, { name: "description", content: "The terms for using stargrep." }],
  }),
  codeSplitGroupings: [],
  component: lazyRouteComponent(loadEngine, "TermsPage"),
});
