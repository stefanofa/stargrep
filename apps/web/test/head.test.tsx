import "./client-branch.ts";
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
  repoStars: null,
  site: { origin: "https://stargrep.com", indexable: true },
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
  expect(await renderPage("/octo")).toContain(`content="Search @octo&#x27;s starred GitHub repos in plain words."`);
});

const previewOf = (html: string) => {
  const head = html.split("</head>")[0] ?? "";
  const tags = [...head.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]*)" content="([^"]*)"\/>/g)];
  const canonical = head.match(/<link rel="canonical" href="([^"]*)"\/>/)?.[1];
  return {
    tags: Object.fromEntries(
      tags.map(([, key, content]) => [key, content?.replace(/&[^;]+;/g, (entity) => entities[entity] ?? entity)]),
    ),
    canonical,
    count: tags.length,
  };
};

test("a shared stars page previews with its own title, description, address and image", async () => {
  const { tags, canonical, count } = previewOf(await renderPage("/octo?q=rust%20tui&sort=stars"));
  expect(tags).toEqual({
    "og:type": "website",
    "og:site_name": "stargrep",
    "og:title": `"rust tui" in @octo's stars · stargrep`,
    "og:description": "Search @octo's starred GitHub repos in plain words.",
    "og:url": "https://stargrep.com/octo?q=rust+tui",
    "og:image": "https://stargrep.com/og/octo.png?q=rust+tui",
    "og:image:type": "image/png",
    "og:image:width": "1200",
    "og:image:height": "630",
    "og:image:alt": "@octo's starred GitHub repos on stargrep",
    "twitter:card": "summary_large_image",
    "twitter:title": `"rust tui" in @octo's stars · stargrep`,
    "twitter:description": "Search @octo's starred GitHub repos in plain words.",
    "twitter:image": "https://stargrep.com/og/octo.png?q=rust+tui",
  });
  expect(count).toBe(Object.keys(tags).length);
  expect(canonical).toBe("https://stargrep.com/octo?q=rust+tui");
});

test("the home page previews as the site, and a page on a preview host names no canonical address", async () => {
  loadSession = async () => ({ ...(await visitor()), site: { origin: "https://pr-7.stargrep.com", indexable: false } });
  try {
    const { tags, canonical } = previewOf(await renderPage("/"));
    expect(tags["og:title"]).toBe("stargrep");
    expect(tags["og:description"]).toBe("Search your starred GitHub repos in plain words.");
    expect(tags["og:url"]).toBe("https://pr-7.stargrep.com/");
    expect(tags["og:image"]).toBe("https://pr-7.stargrep.com/og.png");
    expect(canonical).toBeUndefined();
  } finally {
    loadSession = visitor;
  }
});

test("a page that is no stars page still previews as the site", async () => {
  const { tags, canonical } = previewOf(await renderPage("/not.a.login"));
  expect(tags["og:title"]).toBe("stargrep");
  expect(tags["og:image"]).toBe("https://stargrep.com/og.png");
  expect(tags["og:url"]).toBeUndefined();
  expect(canonical).toBeUndefined();
});

test("the home page a visitor lands on keeps the site's title", async () => {
  expect(titleOf(await renderPage("/"))).toBe("stargrep");
});

test("a path that is no page says so on a styled page with a way home", async () => {
  const html = await renderPage("/not..valid");
  expect(html).toContain("no page here");
  expect(html).toContain(">go home</a>");
  expect(html).toContain("stargrep</a>");
});

test("a page that fails says so without its error, and offers a reload", async () => {
  loadSession = async () => {
    throw new Error("secret detail from the loader");
  };
  try {
    const html = await renderPage("/octo");
    expect(html).toContain("stargrep tripped");
    expect(html).toContain(">reload</button>");
    expect(html).not.toContain("secret detail");
    expect(html).toContain('<meta name="theme-color"');
  } finally {
    loadSession = visitor;
  }
});

test("every page's footer links the source, the API, MCP, privacy, and terms", async () => {
  for (const path of ["/octo", "/privacy", "/terms", "/not..valid"]) {
    const footer = (await renderPage(path)).split("<footer")[1] ?? "";
    const links = [...footer.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, text]) => [
      text,
      href,
    ]);
    expect(links).toEqual([
      ["@stefanofa", "https://x.com/stefanofa"],
      ["source", "https://github.com/stefanofa/stargrep"],
      ["api", "/developers#api"],
      ["mcp", "/developers#mcp"],
      ["privacy", "/privacy"],
      ["terms", "/terms"],
    ]);
  }
});

test("/privacy is the privacy page, and a GitHub user called privacy keeps a page at /@privacy", async () => {
  const privacy = await renderPage("/privacy");
  expect(titleOf(privacy)).toBe("privacy · stargrep");
  expect(privacy).toContain("what stargrep stores");
  expect(titleOf(await renderPage("/@privacy"))).toBe("@privacy's stars · stargrep");
});

test("/terms is the terms page, and a GitHub user called terms keeps a page at /@terms", async () => {
  const terms = await renderPage("/terms");
  expect(titleOf(terms)).toBe("terms · stargrep");
  expect(terms).toContain("provided as is");
  expect(titleOf(await renderPage("/@terms"))).toBe("@terms's stars · stargrep");
});

test("the developers page names the MCP endpoint and every tool the server lists", async () => {
  const { anyoneCanCall, contract } = await import("@stargrep/api/contract");
  const { mcpTools, mcpUrl } = await import("../src/lib/mcp.ts");
  const served = Object.entries(contract)
    .filter(([, procedure]) => anyoneCanCall(procedure))
    .map(([name]) => name);
  expect(mcpTools.map((tool): string => tool.name).sort()).toEqual(served.sort());
  const html = await renderPage("/developers");
  expect(html).toContain(`claude mcp add --transport http stargrep ${mcpUrl}`);
  for (const tool of mcpTools) expect(html).toContain(`>${tool.name}</code>`);
});
