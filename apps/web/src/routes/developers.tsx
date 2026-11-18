import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { loadEngine } from "../lib/engine.ts";

export const Route = createFileRoute("/developers")({
  head: () => ({
    meta: [
      { title: "use stargrep from your agent · stargrep" },
      { name: "description", content: "Search starred GitHub repos from Claude Code, Codex, or Cursor over MCP." },
    ],
  }),
  codeSplitGroupings: [],
  component: lazyRouteComponent(loadEngine, "DevelopersPage"),
});
