import "./register.ts";
import { expect, mock, test } from "bun:test";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { themeColor } from "../scripts/theme.ts";
import type { Session } from "../src/lib/page-data.ts";

// Bun loads a CSS import as an object, where Vite gives the root route a URL string.
mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
// The root route reads the session, which on a real page the Worker answers.
const visitor = async (): Promise<Session> => ({
  viewer: null,
  config: { demoLogin: "demo", demoQuery: "", examples: [], featured: [] } as unknown as Session["config"],
});
let loadSession = visitor;
const loads = await import("../src/lib/load-page.ts");
mock.module("../src/lib/load-page.ts", () => ({ ...loads, loadSession: () => loadSession() }));
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

const entities: Record<string, string> = { "&quot;": '"', "&#x27;": "'", "&amp;": "&" };
const titleOf = (html: string) =>
  html.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/&[^;]+;/g, (entity) => entities[entity] ?? entity);

test("a stars page is titled by whose stars it shows and what it searches", async () => {
  expect(titleOf(await renderPage("/octo"))).toBe("@octo's stars · stargrep");
  expect(titleOf(await renderPage("/octo?q=rust%20tui"))).toBe(`"rust tui" in @octo's stars · stargrep`);
  expect(titleOf(await renderPage("/octo?q="))).toBe("@octo's stars · stargrep");
  expect(await renderPage("/octo")).toContain(`content="Search @octo&#x27;s GitHub stars in plain words."`);
});

test("the home page a visitor lands on keeps the site's title", async () => {
  expect(titleOf(await renderPage("/"))).toBe("stargrep");
});

test("a path that is no page says so on a styled page with a way home", async () => {
  const html = await renderPage("/not..valid");
  expect(html).toContain("no page here");
  expect(html).toContain(">Go home</a>");
  expect(html).toContain("stargrep</a>");
});

test("a page that fails says so without its error, and offers a reload", async () => {
  loadSession = async () => {
    throw new Error("secret detail from the loader");
  };
  try {
    const html = await renderPage("/octo");
    expect(html).toContain("stargrep tripped");
    expect(html).toContain(">Reload</button>");
    expect(html).not.toContain("secret detail");
    expect(html).toContain('<meta name="theme-color"');
  } finally {
    loadSession = visitor;
  }
});
