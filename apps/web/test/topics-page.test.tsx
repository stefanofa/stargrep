import "./client-branch.ts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createORPCErrorFromJson } from "@orpc/client";
import { RepoId } from "@stargrep/github/schemas";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, configure, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Client, SearchResult, Topic, TopicCount, TopicRepo, TopicsList } from "../src/lib/rpc.ts";
import type {} from "../src/routeTree.gen.ts";
import { edgeAnswers } from "./edge-answers.ts";

configure({ asyncUtilTimeout: 4000 });

const repo = (id: number, name: string): TopicRepo => ({
  id: RepoId.make(id),
  owner: "ratatui",
  name,
  url: `https://github.com/ratatui/${name}`,
  description: `${name} draws terminal interfaces.`,
  summary: null,
  language: "Rust",
  topics: ["tui"],
  license: null,
  kind: null,
  archived: false,
  pushedAt: null,
  icon: null,
  ownerType: null,
  ownerAvatarUrl: null,
  devs: 30,
  stars: 1000,
});

const tui: Topic = {
  topic: "tui",
  repos: 1204,
  ranked: 2,
  home: null,
  core: [repo(1, "ratatui"), repo(2, "tui-textarea")],
  built: [],
  related: [],
  people: [],
};

const hit = (id: number, name: string): SearchResult => ({
  ...repo(id, name),
  facets: [],
  reason: "meaning match",
  rankedBy: [],
  metrics: [],
});

const count = (topic: string): TopicCount => ({ topic, repos: 100, ranked: 10 });

type Refusal = "unavailable" | "limited" | "zone";

interface Server {
  topics: ReadonlyArray<TopicCount>;
  // How listTopics answers each typed name, with no q for the first page.
  find: (q: string | undefined) => ReadonlyArray<TopicCount> | Refusal | "hang";
  search: () => ReadonlyArray<SearchResult> | Refusal | "hang";
  asked: { listTopics: Array<string | undefined>; search: Array<string> };
}

let server: Server;

const refuse = (refusal: Refusal) =>
  refusal === "zone"
    ? edgeAnswers(429).search({ scope: { kind: "topic", topic: "tui" }, q: "x" })
    : Promise.reject(
        createORPCErrorFromJson({
          defined: true,
          code: refusal === "limited" ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE",
          message: refusal,
          data: undefined,
        }),
      );

const isRefusal = (found: unknown): found is Refusal =>
  found === "unavailable" || found === "limited" || found === "zone";

const answer = <A,>(found: A | Refusal | "hang"): Promise<A> => {
  if (found === "hang") return new Promise(() => {});
  if (isRefusal(found)) return refuse(found) as Promise<A>;
  return Promise.resolve(found);
};

const client = {
  listTopics: async ({ q }: { q?: string }): Promise<TopicsList> => {
    server.asked.listTopics.push(q);
    const topics = await answer(server.find(q));
    return { topics, total: topics.length, nextOffset: null };
  },
  topic: async () => tui,
  search: async ({ q }: { q: string }) => {
    server.asked.search.push(q);
    return { planSource: "model", results: await answer(server.search()), applied: [] };
  },
  topicPages: async () => ({ pages: [] }),
};

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api: () => client as unknown as Client }));
const { Route: TopicsRoute } = await import("../src/routes/topics.index.tsx");
const { Route: TopicRoute } = await import("../src/routes/topics.$topic.tsx");

beforeEach(() => {
  server = {
    topics: [count("tui"), count("rust")],
    find: (q) => (q === undefined ? server.topics : server.topics.filter(({ topic }) => topic.includes(q))),
    search: () => [hit(3, "bottom")],
    asked: { listTopics: [], search: [] },
  };
});

afterEach(cleanup);

const page = () => within(document.body);

const open = async (path: string) => {
  let sessions = 0;
  const root = createRootRoute({
    component: Outlet,
    // As the real root, the session loads once and never reloads, and a second run throws, since it runs only on the
    // server.
    staleTime: Number.POSITIVE_INFINITY,
    shouldReload: false,
    loader: async () => {
      sessions += 1;
      if (sessions > 1) throw new Error("a server-only function ran in the browser");
      return {
        viewer: null,
        config: { demoLogin: "stefanofa", demoQuery: "", examples: [], featured: [], curated: [] },
        repoStars: null,
        site: { origin: "https://stargrep.com", indexable: true },
      };
    },
  });
  const routes = [
    TopicsRoute.update({ id: "/topics/", path: "/topics/", getParentRoute: () => root } as never),
    TopicRoute.update({ id: "/topics/$topic", path: "/topics/$topic", getParentRoute: () => root } as never),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes as unknown as Array<AnyRoute>),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await page().findByRole("heading", { level: 1 });
  return router;
};

const grid = () => within(page().getByRole("main")).getByRole("list");

const tiles = () =>
  within(grid())
    .queryAllByRole("link")
    .map((link) => link.textContent);

describe("the topics page", () => {
  test("topics that didn't load can be asked for again", async () => {
    const user = userEvent.setup();
    server.find = () => "unavailable";
    await open("/topics");
    expect(page().getByRole("heading", { name: "couldn't load topics" })).toBeTruthy();
    server.find = () => server.topics;
    await user.click(page().getByRole("button", { name: "try again" }));
    await waitFor(() => expect(tiles()).toEqual(["tui", "rust"]));
  });

  test("a name search that fails says so, not that no topic is called that, and tries again", async () => {
    const user = userEvent.setup();
    await open("/topics");
    server.find = () => "unavailable";
    await user.type(page().getByRole("searchbox"), "ru");
    expect(await page().findByRole("heading", { name: "couldn't look that up" })).toBeTruthy();
    expect(page().queryByRole("heading", { name: "no topic like that" })).toBeNull();
    server.find = (q) => server.topics.filter(({ topic }) => topic.includes(q ?? ""));
    await user.click(page().getByRole("button", { name: "try again" }));
    await waitFor(() => expect(tiles()).toEqual(["rust"]));
  });

  test("the last matches stay on screen while the next name is looked up", async () => {
    const user = userEvent.setup();
    await open("/topics");
    await user.type(page().getByRole("searchbox"), "t");
    await waitFor(() => expect(server.asked.listTopics).toContain("t"));
    await waitFor(() => expect(tiles()).toEqual(["tui", "rust"]));
    server.find = () => "hang";
    await user.type(page().getByRole("searchbox"), "u");
    await waitFor(() => expect(server.asked.listTopics).toContain("tu"));
    expect(tiles()).toEqual(["tui", "rust"]);
    expect(grid().getAttribute("aria-busy")).toBe("true");
    expect(page().queryByText("looking…")).toBeNull();
  });
});

describe("a topic's search", () => {
  test("holds the answer's place while it runs", async () => {
    server.search = () => "hang";
    await open("/topics/tui?q=terminal+dashboards");
    const status = await page().findByRole("status");
    expect(status.textContent).toBe("searching…");
    // The tile the results fill is already on screen, so they land without moving the lists under it.
    expect(status.closest("[aria-busy='true']")).not.toBeNull();
  });

  test("a search that fails can be asked again", async () => {
    const user = userEvent.setup();
    server.search = () => "unavailable";
    await open("/topics/tui?q=terminal+dashboards");
    expect(await page().findByRole("heading", { name: "stargrep couldn't search that" })).toBeTruthy();
    server.search = () => [hit(3, "bottom")];
    await user.click(page().getByRole("button", { name: "try again" }));
    expect(await page().findByRole("heading", { name: "found 1" })).toBeTruthy();
    expect(server.asked.search).toEqual(["terminal dashboards", "terminal dashboards"]);
  });

  test("a network that asked too often is told to wait, from the API or the zone", async () => {
    for (const refusal of ["limited", "zone"] as const) {
      server.search = () => refusal;
      await open("/topics/tui?q=terminal+dashboards");
      expect(await page().findByRole("heading", { name: "lots of searches from your network" })).toBeTruthy();
      expect(page().getByRole("button", { name: "try again" })).toBeTruthy();
      cleanup();
    }
  });
});
