import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadEngine } from "../lib/engine.ts";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "privacy · stargrep" },
      { name: "description", content: "What stargrep stores and what it sends." },
    ],
  }),
  codeSplitGroupings: [],
  component: lazyRouteComponent(loadEngine, "PrivacyPage"),
});
