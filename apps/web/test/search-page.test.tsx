import "./register.ts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, configure, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as real from "../src/lib/library-collection.ts";
import type { PlannedRepo, PlannedStatus } from "../src/lib/planned.ts";
import type { LibraryRepo, SearchResult, SyncStatus, Viewer } from "../src/lib/rpc.ts";
import type {} from "../src/routeTree.gen.ts";

type Repo = LibraryRepo & PlannedRepo;

interface Server {
  viewer: Viewer;
  repos: Array<Repo>;
  status: SyncStatus & PlannedStatus;
  search: (q: string) => Array<SearchResult>;
  searches: Array<string>;
}

let server: Server;

const page = () => within(document.body);

const api = () => ({
  viewer: async () => server.viewer,
  library: async () => ({ repos: server.repos }),
  syncStatus: async () => server.status,
  triggerSync: async () => server.status,
  search: async ({ q }: { q: string }) => {
    server.searches.push(q);
    return { results: server.search(q) };
  },
});

let library: real.Library;

configure({ asyncUtilTimeout: 4000 });

mock.module("../src/lib/rpc.ts", () => ({ api, signedOut: () => false }));
mock.module("../src/lib/library-collection.ts", () => ({ ...real, getLibrary: () => library }));

const { Route: SearchRoute } = await import("../src/routes/search.tsx");

const repo = (id: number, owner: string, name: string, description: string, extra: Partial<Repo> = {}): Repo => ({
  id: id as LibraryRepo["id"],
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  description,
  summary: description,
  language: "Rust",
  topics: [],
  license: null,
  kind: null,
  archived: false,
  pushedAt: "2026-11-01T00:00:00.000Z",
  keywords: [],
  starredAt: `2026-10-${String(10 + id).padStart(2, "0")}T00:00:00.000Z`,
  stars: 1000 * id,
  icon: null,
  ownerType: "user",
  ownerAvatarUrl: null,
  read: true,
  ...extra,
});

const repos = (): Array<Repo> => [
  repo(1, "ratatui", "ratatui", "Widgets for terminal dashboards.", {
    icon: { url: "https://icons.example/ratatui.webp", plate: "light", size: 128 },
    ownerType: "org",
  }),
  repo(2, "ClementTsang", "bottom", "A system monitor dashboard for the terminal."),
  repo(3, "tokio-rs", "console", "A debugger for async rust.", {
    ownerType: "org",
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    read: false,
    summary: null,
  }),
  repo(4, "gyscos", "cursive", "A text UI library with views.", { read: false, summary: null }),
  repo(5, "fdehau", "tui-rs", "Where ratatui came from."),
  repo(6, "rhysd", "tui-textarea", "A multi-line text editor widget."),
];

const status = (extra: Partial<Server["status"]>): Server["status"] => ({
  login: "junodev",
  state: "done",
  requestedAt: "2026-11-05T10:00:00.000Z",
  syncedAt: "2026-11-05T10:00:00.000Z",
  ...extra,
});

const reading = { total: 6, read: 4, failed: 0 };
const allRead = { total: 6, read: 6, failed: 0 };

const hit = (repo: Repo): SearchResult => ({ ...repo, reason: "meaning match", rankedBy: [], metrics: [] });

beforeEach(() => {
  server = {
    viewer: { login: "junodev", name: null, avatarUrl: null, starredCount: 6 },
    repos: repos(),
    status: status({ enrichment: allRead }),
    search: () => [],
    searches: [],
  };
  library = real.makeLibrary(() =>
    api()
      .library()
      .then(({ repos }) => repos),
  );
});

afterEach(cleanup);

const open = async (path: string) => {
  const root = createRootRoute({ component: Outlet });
  const search = SearchRoute.update({
    id: "/search",
    path: "/search",
    getParentRoute: () => root,
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([search]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await page().findByRole("searchbox", { name: "Search your stars" });
  await waitFor(() => expect(document.querySelector("[aria-live]")?.textContent).not.toContain("loading"));
};

const strip = () => document.querySelector("[aria-live]")?.textContent ?? "";
const tile = () => page().getByRole("searchbox").closest("[data-slot=tile]") as HTMLElement;
const rail = () => document.querySelector("[data-slot=rail] > div") as HTMLElement | null;
const mark = () => document.querySelector("header svg[data-pose]")?.getAttribute("data-pose");
const chips = () =>
  page()
    .queryAllByText("not read yet")
    .filter((chip) => chip.checkVisibility?.() ?? true);

const settle = (ms = 400) => act(() => Bun.sleep(ms));

describe("the search page in each state", () => {
  test("browsing a synced library: the strip counts, the controls sit in the tile", async () => {
    await open("/search");
    await waitFor(() => expect(strip()).toContain("6 stars"));
    expect(strip()).toContain("synced");
    expect(within(tile()).getByRole("button", { name: /Sort by/ })).toBeTruthy();
    expect(within(tile()).getByRole("group", { name: "View" })).toBeTruthy();
    expect(rail()).toBeNull();
    expect(mark()).toBe("idle");
  });

  test("importing: real counts on the strip and the rail, and placeholders where stars will land", async () => {
    server.viewer = { ...server.viewer, starredCount: 10 };
    server.status = status({ state: "queued", enrichment: null });
    await open("/search");
    await waitFor(() => expect(strip()).toContain("importing your stars"));
    expect(strip()).toContain("6 of 10");
    expect(rail()?.style.width).toBe("60%");
    expect(mark()).toBe("happy");
    await waitFor(() => expect(page().getAllByText(/stars so far/).length).toBeGreaterThan(0));
    expect(document.querySelectorAll("ol[aria-busy=true] > li").length).toBe(8);
    expect(document.querySelectorAll("ol > li > [aria-busy=true]").length).toBe(2);
  });

  test("reading: the rail follows the read count and unread repos carry a chip with their description", async () => {
    server.status = status({ enrichment: reading });
    await open("/search");
    await waitFor(() => expect(strip()).toContain("reading your stars"));
    expect(strip()).toContain("4 of 6 understood");
    expect(rail()?.style.width).toBe("66.7%");
    expect(mark()).toBe("thinking");
    expect(page().getByText("A debugger for async rust.")).toBeTruthy();
    expect(page().getAllByText("not read yet").length).toBeGreaterThan(0);
  });

  test("searching while reading: grouped results and a partial count", async () => {
    server.status = status({ enrichment: reading });
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/search?q=terminal");
    await waitFor(() => expect(strip()).toMatch(/found \d so far/));
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "matching meaning 1 from the 4 read so far" })).toBeTruthy(),
    );
    expect(page().getByRole("heading", { name: "matching words 2 from all 6" })).toBeTruthy();
    expect(strip()).toContain("2 stars not read yet");
  });

  test("results once everything is read: one list, a plain count, no rail", async () => {
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/search?q=terminal");
    await waitFor(() => expect(strip()).toContain("found 3"));
    expect(strip()).toContain("of 6");
    expect(page().queryByRole("heading", { name: /matching words/ })).toBeNull();
    expect(page().getByRole("list", { name: "Results" })).toBeTruthy();
    expect(rail()).toBeNull();
  });

  test("empty while reading: the answer could still be in the unread part", async () => {
    server.status = status({ enrichment: reading });
    await open("/search?q=record%20terminal%20sessions%20as%20gifs");
    await waitFor(() => expect(page().getByRole("heading", { name: "not in the 4 i've read yet" })).toBeTruthy());
    expect(page().getByText(/it might be in the 2 stars i'm still reading/)).toBeTruthy();
    expect(strip()).toContain("nothing yet");
    expect(mark()).toBe("unsure");
    expect(page().queryByText(/everyone/)).toBeNull();
  });

  test("empty after everything is read: a real no, with rephrasings that search again", async () => {
    const user = userEvent.setup();
    await open("/search?q=record%20terminal%20sessions%20as%20gifs");
    await waitFor(() => expect(page().getByRole("heading", { name: "nothing in all 6 stars" })).toBeTruthy());
    expect(strip()).toContain("nothing found");
    expect(strip()).toContain("all 6 stars read");
    expect(mark()).toBe("sad");
    expect(page().queryByText(/everyone/)).toBeNull();
    await user.click(page().getByRole("button", { name: "terminal sessions" }));
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("terminal sessions");
  });

  test("the sort menu and view toggle stay inside the search tile in every state", async () => {
    const states: Array<[string, () => void]> = [
      ["/search", () => {}],
      ["/search", () => (server.status = status({ state: "queued", enrichment: null }))],
      ["/search?q=terminal", () => (server.status = status({ enrichment: reading }))],
      ["/search?q=nothing%20like%20this", () => (server.status = status({ enrichment: reading }))],
      ["/search?q=nothing%20like%20this", () => {}],
    ];
    for (const [path, arrange] of states) {
      arrange();
      await open(path);
      await settle();
      expect(within(tile()).getByRole("group", { name: "View" })).toBeTruthy();
      expect(within(tile()).getByRole("button", { name: /Sort by/ })).toBeTruthy();
      cleanup();
      server.status = status({ enrichment: allRead });
    }
  }, 20_000);

  test("when reading finishes, the flags clear and the search runs again", async () => {
    server.status = status({ enrichment: reading });
    await open("/search?q=async");
    await waitFor(() => expect(server.searches).toContain("async"));
    await waitFor(() => expect(page().getAllByText("not read yet").length).toBeGreaterThan(0));
    const before = server.searches.length;

    server.repos = server.repos.map((entry) => ({ ...entry, read: true }));
    server.status = status({ enrichment: allRead });
    await waitFor(() => expect(server.searches.length).toBe(before + 1), { timeout: 8000 });
    expect(server.searches.at(-1)).toBe("async");
    await waitFor(() => expect(chips()).toEqual([]));
    expect(strip()).not.toContain("so far");
  }, 15_000);
});
