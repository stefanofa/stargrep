import { expect, mock, test } from "bun:test";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { themeColor } from "../scripts/theme.ts";

// Bun loads a CSS import as an object, where Vite gives the root route a URL string.
mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
const { routeTree } = await import("../src/routeTree.gen.ts");

const renderPage = async (path: string) => {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), isServer: true });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
};

test("the head carries a theme color for light and for dark mode", async () => {
  const head = (await renderPage("/")).split("</head>")[0] ?? "";
  const themeColors = [...head.matchAll(/<meta name="theme-color" content="([^"]*)" media="([^"]*)"\/>/g)].map(
    ([, content, media]) => ({ content, media }),
  );
  const background = themeColor("background");
  expect(themeColors).toEqual([
    { content: background.light, media: "(prefers-color-scheme: light)" },
    { content: background.dark, media: "(prefers-color-scheme: dark)" },
  ]);
});
