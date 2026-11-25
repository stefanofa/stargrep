import "./client-branch.ts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Login } from "@stargrep/github/schemas";
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
import type { Client, People, Person, Viewer } from "../src/lib/rpc.ts";
import type {} from "../src/routeTree.gen.ts";

configure({ asyncUtilTimeout: 4000 });

const person = (login: string, extra: Partial<Person> = {}): Person => ({
  login,
  avatarUrl: null,
  curated: false,
  stars: 616,
  lastStarredAt: "2026-11-06T00:00:00.000Z",
  languages: [
    { language: "TypeScript", share: 0.49 },
    { language: "Rust", share: 0.1 },
  ],
  topics: ["react", "nextjs", "ai"],
  shared: null,
  ...extra,
});

interface Server {
  viewer: Viewer | null;
  list: ReadonlyArray<Person>;
  topics: People["topics"];
  pageSize: number;
  refuse: boolean;
  asked: Array<{ sort: string | undefined; offset: number | undefined; topic: string | undefined }>;
}

let server: Server;

const people = async ({
  sort,
  offset = 0,
  topic,
}: {
  sort?: People["sort"];
  offset?: number;
  topic?: string;
}): Promise<People> => {
  server.asked.push({ sort, offset, topic });
  if (server.refuse) throw new Error("refused");
  const kept = topic === undefined ? server.list : server.list.filter((person) => person.topics.includes(topic));
  const end = offset + server.pageSize;
  return {
    sort: sort ?? "recently-active",
    people: kept.slice(offset, end),
    total: kept.length,
    nextOffset: end < kept.length ? end : null,
    topics: server.topics,
  };
};

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({
  ...rpc,
  api: () => ({ people, followedLogins: async () => ({ follows: [] }) }) as unknown as Client,
}));
const { Route: PeopleRoute } = await import("../src/routes/people.tsx");

beforeEach(() => {
  server = { viewer: null, list: [], topics: [], pageSize: 24, refuse: false, asked: [] };
});

afterEach(cleanup);

const page = () => within(document.body);

const open = async () => {
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
        viewer: server.viewer,
        config: { demoLogin: Login.make("stefanofa"), demoQuery: "", examples: [], featured: [], curated: [] },
        repoStars: null,
        discover: "people",
        site: { origin: "https://stargrep.com", indexable: true, engine: [] },
      };
    },
  });
  const route = PeopleRoute.update({ id: "/people", path: "/people", getParentRoute: () => root } as never);
  const router = createRouter({
    routeTree: root.addChildren([route as unknown as AnyRoute]),
    history: createMemoryHistory({ initialEntries: ["/people"] }),
  });
  render(<RouterProvider router={router} />);
  await page().findByRole("heading", { level: 1, name: "discover people" });
  return router;
};

const cards = () =>
  within(page().getByRole("list", { name: "people" }))
    .queryAllByRole("listitem")
    .filter((item) => item.getAttribute("aria-hidden") === null && item.querySelector("h3") !== null);

describe("discover's people", () => {
  test("a signed-in viewer sees the people most like them first, and can sort by the latest star", async () => {
    const user = userEvent.setup();
    server.viewer = { login: "junodev", name: null, avatarUrl: null, starredCount: 6 };
    server.list = [person("simonw", { shared: 86 })];
    const router = await open();
    const sorts = within(page().getByRole("navigation", { name: "Sort people" }));
    expect(sorts.getByRole("link", { name: "most like you" }).getAttribute("aria-current")).not.toBeNull();
    await user.click(sorts.getByRole("link", { name: "recently active" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "recently-active" }));
    await waitFor(() =>
      expect(
        within(page().getByRole("navigation", { name: "Sort people" }))
          .getByRole("link", { name: "recently active" })
          .getAttribute("aria-current"),
      ).not.toBeNull(),
    );
    expect(server.asked.map(({ sort }) => sort)).toEqual(["most-like-you", "recently-active"]);
  });

  test("anyone else gets the latest star first, with no sort to pick", async () => {
    server.list = [person("simonw")];
    await open();
    expect(page().queryByRole("navigation", { name: "Sort people" })).toBeNull();
    expect(page().getByText("latest star first")).toBeTruthy();
    expect(server.asked.map(({ sort }) => sort)).toEqual(["recently-active"]);
  });

  test("narrows to the people into a topic, from a chip or the menu, and a chip that is on takes it off", async () => {
    const user = userEvent.setup();
    server.list = [
      person("ana", { topics: ["rust", "cli"] }),
      person("bo", { topics: ["llm"] }),
      person("cy", { topics: ["neovim"] }),
    ];
    server.topics = ["rust", "llm", "cli", "python", "neovim"].map((topic, index) => ({ topic, people: 10 - index }));
    const router = await open();
    const into = () => within(page().getByRole("navigation", { name: "people into a topic" }));
    expect(
      into()
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["rust", "llm", "cli", "python"]);
    expect(into().getByRole("button", { name: "Pick a topic" }).textContent).toBe("any topic");

    await user.click(into().getByRole("link", { name: "rust" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ topic: "rust" }));
    await waitFor(() => expect(cards().length).toBe(1));
    expect(into().getByRole("link", { name: "rust" }).getAttribute("aria-current")).toBe("true");

    await user.click(into().getByRole("link", { name: "rust" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(cards().length).toBe(3));

    // A topic past the chips waits in the menu, and the menu names it once it is on.
    await user.click(into().getByRole("button", { name: "Pick a topic" }));
    await user.click(await page().findByRole("menuitemradio", { name: /^neovim/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ topic: "neovim" }));
    await waitFor(() => expect(into().getByRole("button", { name: "Pick a topic" }).textContent).toBe("neovim"));
    expect(cards().length).toBe(1);
    expect(server.asked.map(({ topic }) => topic)).toEqual([undefined, "rust", undefined, "neovim"]);
  });

  test("a topic nobody on the list is into says so and keeps the topics to pick another", async () => {
    server.list = [person("ana", { topics: ["rust"] })];
    server.topics = [{ topic: "rust", people: 1 }];
    const router = await open();
    await router.navigate({ to: "/people", search: { topic: "zig" } });
    expect(await page().findByRole("heading", { name: "nobody here is into zig yet" })).toBeTruthy();
    expect(page().getByRole("navigation", { name: "people into a topic" })).toBeTruthy();
  });

  test("show more adds the next page under the cards already shown, into the same topic, until the list ends", async () => {
    const user = userEvent.setup();
    server.pageSize = 2;
    server.list = ["a-one", "b-two", "c-three", "d-four", "e-five", "f-six"].map((login, index) =>
      person(login, { topics: index < 5 ? ["rust"] : ["go"] }),
    );
    const router = await open();
    await router.navigate({ to: "/people", search: { topic: "rust" } });
    await waitFor(() => expect(cards().length).toBe(2));
    await user.click(page().getByRole("button", { name: "show more" }));
    await waitFor(() => expect(cards().length).toBe(4));
    await user.click(page().getByRole("button", { name: "show more" }));
    await waitFor(() => expect(cards().length).toBe(5));
    expect(page().queryByRole("button", { name: "show more" })).toBeNull();
    expect(server.asked.slice(1).map(({ offset, topic }) => [offset, topic])).toEqual([
      [0, "rust"],
      [2, "rust"],
      [4, "rust"],
    ]);
  });

  test("a page that fails to load can be asked for again", async () => {
    const user = userEvent.setup();
    server.pageSize = 1;
    server.list = [person("a-one"), person("b-two")];
    await open();
    server.refuse = true;
    await user.click(page().getByRole("button", { name: "show more" }));
    await page().findByText("couldn't load more people.");
    server.refuse = false;
    await user.click(page().getByRole("button", { name: "try again" }));
    await waitFor(() => expect(cards().length).toBe(2));
  });

  test("an empty list says it fills in overnight, under the field that goes to anyone's stars", async () => {
    await open();
    expect(page().getByRole("heading", { name: "nobody here yet" })).toBeTruthy();
    expect(page().queryByRole("list", { name: "people" })).toBeNull();
    expect(page().getByRole("form", { name: "Whose stars" })).toBeTruthy();
  });

  test("a list the API refuses says so and tries again", async () => {
    const user = userEvent.setup();
    server.refuse = true;
    server.list = [person("t3dotgg")];
    await open();
    expect(page().getByRole("heading", { name: "couldn't load people" })).toBeTruthy();
    server.refuse = false;
    await user.click(page().getByRole("button", { name: "try again" }));
    await waitFor(() => expect(cards().length).toBe(1));
  });
});
