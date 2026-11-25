import "./client-branch.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Login } from "@stargrep/github/schemas";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, configure, render, within } from "@testing-library/react";
import type { Client, Topic, TopicCount } from "../src/lib/rpc.ts";
import type {} from "../src/routeTree.gen.ts";

configure({ asyncUtilTimeout: 4000 });

const logo = { url: "https://stargrep.test/icons/logos/nextdotjs.ae8fd2e153.svg", plate: "light", size: 128 } as const;
const counted = (topic: string, icon: TopicCount["icon"]): TopicCount => ({
  topic,
  repos: 900,
  ranked: 300,
  devs: 400,
  icon,
});

const nextjs: Topic = {
  ...counted("nextjs", logo),
  home: null,
  core: [],
  built: [],
  related: [
    counted("react", { ...logo, url: "https://stargrep.test/icons/logos/react.f772626394.svg" }),
    counted("machine-learning", null),
  ],
  people: [],
};

const api = {
  listTopics: async () => ({
    topics: [counted("nextjs", logo), counted("machine-learning", null)],
    total: 2,
    nextOffset: null,
  }),
  topic: async () => nextjs,
  topicPages: async () => ({ pages: [] }),
};

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api: () => api as unknown as Client }));
const { Route: TopicsRoute } = await import("../src/routes/topics.index.tsx");
const { Route: TopicRoute } = await import("../src/routes/topics.$topic.tsx");

afterEach(cleanup);

const page = () => within(document.body);

const open = async (path: string) => {
  const root = createRootRoute({
    component: Outlet,
    loader: async () => ({
      viewer: null,
      config: { demoLogin: Login.make("stefanofa"), demoQuery: "", examples: [], featured: [], curated: [] },
      repoStars: null,
      discover: "people",
      site: { origin: "https://stargrep.com", indexable: true, engine: [] },
    }),
  });
  const topics = TopicsRoute.update({ id: "/topics/", path: "/topics/", getParentRoute: () => root } as never);
  const topic = TopicRoute.update({
    id: "/topics/$topic",
    path: "/topics/$topic",
    getParentRoute: () => root,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([topics as unknown as AnyRoute, topic as unknown as AnyRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await page().findByRole("heading", { level: 1 });
};

const imageIn = (element: HTMLElement | null) => element?.querySelector("img")?.getAttribute("src") ?? null;

describe("topic visuals", () => {
  test("a topic in the list shows its logo, and one without shows two letters", async () => {
    await open("/topics");
    const tile = (name: string) => page().getByRole("link", { name }).closest("li");
    expect(imageIn(tile("nextjs"))).toBe(logo.url);
    expect(imageIn(tile("machine-learning"))).toBeNull();
    expect(within(tile("machine-learning") as HTMLElement).getByText("ml")).toBeTruthy();
  });

  test("a topic's page shows its logo by its name, and a related topic's chip shows its own", async () => {
    await open("/topics/nextjs");
    expect(
      imageIn(page().getByRole("heading", { level: 1, name: "nextjs" }).closest<HTMLElement>("[data-slot='tile']")),
    ).toBe(logo.url);
    const related = within(page().getByRole("navigation", { name: "related topics" }));
    expect(imageIn(related.getByRole("link", { name: "react" }))).toBe(
      "https://stargrep.test/icons/logos/react.f772626394.svg",
    );
    expect(imageIn(related.getByRole("link", { name: "machine-learning" }))).toBeNull();
  });
});
