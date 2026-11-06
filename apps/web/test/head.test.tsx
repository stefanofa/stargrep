import { expect, mock, test } from "bun:test";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { themeColor } from "../scripts/theme.ts";
import type { Session } from "../src/lib/page-data.ts";

// Bun loads a CSS import as an object, where Vite gives the root route a URL string.
mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
// The root route reads the session, which on a real page the Worker answers.
const loads = await import("../src/lib/load-page.ts");
mock.module("../src/lib/load-page.ts", () => ({
  ...loads,
  loadSession: async (): Promise<Session> => ({
    viewer: null,
    config: { demoLogin: "demo", demoQuery: "", examples: [], featured: [] } as unknown as Session["config"],
  }),
}));
const { routeTree } = await import("../src/routeTree.gen.ts");

const renderPage = async (path: string) => {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), isServer: true });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
};

// The root route owns the head. A path that is no GitHub login stops before any page loads data.
test("the head carries a theme color for light and for dark mode", async () => {
  const head = (await renderPage("/not.a.login")).split("</head>")[0] ?? "";
  const themeColors = [...head.matchAll(/<meta name="theme-color" content="([^"]*)" media="([^"]*)"\/>/g)].map(
    ([, content, media]) => ({ content, media }),
  );
  const background = themeColor("background");
  expect(themeColors).toEqual([
    { content: background.light, media: "(prefers-color-scheme: light)" },
    { content: background.dark, media: "(prefers-color-scheme: dark)" },
  ]);
});
