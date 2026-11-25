import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadTextPages } from "../lib/text-pages.ts";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "privacy · stargrep" },
      { name: "description", content: "What stargrep stores and what it sends." },
    ],
  }),
  codeSplitGroupings: [],
  component: lazyRouteComponent(loadTextPages, "PrivacyPage"),
});
