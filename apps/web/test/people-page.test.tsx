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
  pageSize: number;
  refuse: boolean;
  asked: Array<{ sort: string | undefined; offset: number | undefined }>;
}

let server: Server;

const people = async ({ sort, offset = 0 }: { sort?: People["sort"]; offset?: number }): Promise<People> => {
  server.asked.push({ sort, offset });
  if (server.refuse) throw new Error("refused");
  const end = offset + server.pageSize;
  return {
    sort: sort ?? "recently-active",
    people: server.list.slice(offset, end),
    total: server.list.length,
    nextOffset: end < server.list.length ? end : null,
    topics: [],
  };
};

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({
  ...rpc,
  api: () => ({ people, followedLogins: async () => ({ follows: [] }) }) as unknown as Client,
}));
const { Route: PeopleRoute } = await import("../src/routes/people.tsx");

beforeEach(() => {
  server = { viewer: null, list: [], pageSize: 24, refuse: false, asked: [] };
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
  await page().findByRole("heading", { level: 1, name: /^people/ });
  return router;
};

const cards = () =>
  within(page().getByRole("list", { name: "people" }))
    .queryAllByRole("listitem")
    .filter((item) => item.getAttribute("aria-hidden") === null && item.querySelector("h2") !== null);

describe("the people page", () => {
  test("a card says who, how many stars, what about, and when, and opens their stars", async () => {
    server.list = [person("t3dotgg"), person("api", { topics: [], languages: [] })];
    await open();
    const [first, second] = cards();
    const card = within(first as HTMLElement);
    expect(card.getByRole("link", { name: "@t3dotgg" }).getAttribute("href")).toBe("/t3dotgg");
    expect(card.getByText("616 stars")).toBeTruthy();
    expect(card.getByText("TypeScript 49%")).toBeTruthy();
    expect(card.getByText("mostly tagged react · nextjs · ai")).toBeTruthy();
    expect(card.getByText("last starred Nov 6, 2026")).toBeTruthy();
    expect(card.queryByText(/you share/)).toBeNull();
    // A login named like a stargrep path lives at /@login.
    expect(
      within(second as HTMLElement)
        .getByRole("link", { name: "@api" })
        .getAttribute("href"),
    ).toBe("/@api");
    expect(within(second as HTMLElement).queryByText(/mostly tagged/)).toBeNull();
    expect(page().queryByRole("button", { name: "show more" })).toBeNull();
    expect(page().getByRole("form", { name: "Whose stars" })).toBeTruthy();
  });

  test("signed in, each card says how many stars the viewer shares with them", async () => {
    server.viewer = { login: "junodev", name: null, avatarUrl: null, starredCount: 6 };
    server.list = [person("simonw", { shared: 86 }), person("torvalds", { shared: 0 })];
    await open();
    expect(page().getByText("you share 86 stars")).toBeTruthy();
    expect(page().getByText("you share no stars")).toBeTruthy();
  });

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
    expect(server.asked.map(({ sort }) => sort)).toEqual(["recently-active"]);
  });

  test("show more adds the next page under the cards already shown, until the list ends", async () => {
    const user = userEvent.setup();
    server.pageSize = 2;
    server.list = ["a-one", "b-two", "c-three", "d-four", "e-five"].map((login) => person(login));
    await open();
    expect(cards().length).toBe(2);
    expect(page().getByRole("heading", { level: 1 }).textContent).toBe("people5");
    await user.click(page().getByRole("button", { name: "show more" }));
    await waitFor(() => expect(cards().length).toBe(4));
    await user.click(page().getByRole("button", { name: "show more" }));
    await waitFor(() => expect(cards().length).toBe(5));
    expect(page().queryByRole("button", { name: "show more" })).toBeNull();
    expect(server.asked.map(({ offset }) => offset)).toEqual([0, 2, 4]);
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

  test("an empty list says it fills in overnight", async () => {
    await open();
    expect(page().getByRole("heading", { name: "nobody here yet" })).toBeTruthy();
    expect(page().queryByRole("list", { name: "people" })).toBeNull();
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
