import "./register.ts";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createORPCErrorFromJson } from "@orpc/client";
import type { WireCode } from "@stargrep/api/errors";
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
import * as DateTime from "effect/DateTime";
import * as real from "../src/lib/library-collection.ts";
import type { LibraryRepo, SearchResult, SyncStatus, Viewer } from "../src/lib/rpc.ts";
import type {} from "../src/routeTree.gen.ts";
import { syncStatus } from "./sync-status.fixture.ts";

type Repo = LibraryRepo;

interface Server {
  viewer: Viewer;
  signedIn: boolean;
  repos: Array<Repo>;
  status: SyncStatus;
  search: (q: string) => Array<SearchResult> | Promise<Array<SearchResult>>;
  searches: Array<string>;
  refusals: Record<string, "LOGIN_NOT_FOUND" | "SYNC_BUSY" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE">;
  calls: { library: number; syncStatus: number };
}

let server: Server;

// The API marks every error its contract defines.
const answered = (code: WireCode) => createORPCErrorFromJson({ defined: true, code, message: code, data: undefined });

const page = () => within(document.body);

const entrances = () => {
  const animate = spyOn(Element.prototype, "animate");
  return {
    of: (name: RegExp) =>
      animate.mock.contexts.filter(
        (item) => item instanceof HTMLLIElement && name.test(item.querySelector("h3")?.textContent ?? ""),
      ).length,
    [Symbol.dispose]: () => animate.mockRestore(),
  };
};

const api = () => ({
  viewer: async () => {
    if (!server.signedIn) throw new Error("signed out");
    return server.viewer;
  },
  library: async () => {
    server.calls.library += 1;
    return { repos: server.repos };
  },
  syncStatus: async () => {
    server.calls.syncStatus += 1;
    return server.status;
  },
  triggerSync: async ({ login }: { login: string }) => {
    const refusal = server.refusals[login];
    if (refusal !== undefined) throw answered(refusal);
    return server.status;
  },
  stars: async ({ login }: { login: string }) => ({ login, repos: server.repos, nextCursor: null }),
  config: async () => ({
    demoLogin: "stefanofa",
    demoQuery: "terminal dashboard",
    examples: ["python package manager", "terminal recorder", "fuzzy finder"],
    featured: ["stefanofa"],
  }),
  search: async ({ q }: { q: string }) => {
    server.searches.push(q);
    return { results: await server.search(q) };
  },
});

let library: real.Library;

configure({ asyncUtilTimeout: 4000 });

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api }));
mock.module("../src/lib/library-collection.ts", () => ({ ...real, getLibrary: () => library }));

const { Route: StarsRoute } = await import("../src/routes/{-$login}.tsx");

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

const reading = { total: 6, read: 4, failed: 0 };
const allRead = { total: 6, read: 6, failed: 0 };
const arriving = { total: 6, read: 0, failed: 0 };

const status = (extra: Partial<Server["status"]>): Server["status"] => syncStatus({ enrichment: allRead, ...extra });
// A sync waiting for GitHub budget, due to start in 24 minutes with 3 ahead of it.
const inLine = () =>
  status({
    login: "linewaiter",
    state: "waiting",
    syncedAt: null,
    waiting: {
      ahead: 3,
      startsAt: DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { minutes: 24 })),
    },
    starredTotal: 412,
    enrichment: arriving,
  });
const hit = (repo: Repo): SearchResult => ({ ...repo, reason: "meaning match", rankedBy: [], metrics: [] });

beforeEach(() => {
  server = {
    viewer: { login: "junodev", name: null, avatarUrl: null, starredCount: 6 },
    signedIn: true,
    repos: repos(),
    status: status({ enrichment: allRead }),
    search: () => [],
    searches: [],
    refusals: {},
    calls: { library: 0, syncStatus: 0 },
  };
  library = real.makeLibrary(() =>
    real.onePage(
      api()
        .library()
        .then(({ repos }) => repos),
    ),
  );
});

afterEach(cleanup);

const open = async (path: string, label: string | RegExp = "Search your stars", settle = true) => {
  // The root route loads the session, as the Worker does for the first page.
  const root = createRootRoute({
    component: Outlet,
    loader: async () => ({ viewer: server.signedIn ? server.viewer : null, config: await api().config() }),
  });
  const stars = StarsRoute.update({
    id: "/{-$login}",
    path: "/{-$login}",
    getParentRoute: () => root,
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([stars]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await page().findByRole("searchbox", { name: label });
  if (settle) await waitFor(() => expect(strip()).not.toContain("loading"));
  return router;
};

const strip = () => document.querySelector("[role=status]")?.closest("p")?.textContent ?? "";
const announced = () => page().getByRole("status").textContent;
// What one breakpoint shows of an element: its text without the parts that breakpoint hides.
const shownAt = (element: Element, width: "phone" | "desktop") => {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(width === "phone" ? '[class~="max-sm:hidden"]' : '[class~="sm:hidden"]'))
    hidden.remove();
  return copy.textContent ?? "";
};
const statusLine = () => page().getByRole("status").closest("p")?.parentElement as HTMLElement;
const tile = () => page().getByRole("searchbox").closest("[data-slot=tile]") as HTMLElement;
const rail = () => page().queryByRole("progressbar");
const mark = () => document.querySelector("header svg[data-pose]")?.getAttribute("data-pose");
const chips = () =>
  page()
    .queryAllByText("not read yet")
    .filter((chip) => chip.checkVisibility?.() ?? true);

const settle = (ms = 400) => act(() => Bun.sleep(ms));

describe("the search page in each state", () => {
  test("browsing a synced library: the strip counts, the controls sit in the tile", async () => {
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("6 stars"));
    expect(strip()).toContain("synced");
    expect(within(tile()).getByRole("button", { name: /Sort by/ })).toBeTruthy();
    expect(within(tile()).getByRole("group", { name: "View" })).toBeTruthy();
    expect(rail()).toBeNull();
    await waitFor(() => expect(mark()).toBe("idle"));
  });

  test("importing: real counts on the strip and the rail, and placeholders where stars will land", async () => {
    server.viewer = { ...server.viewer, starredCount: 10 };
    server.status = status({ state: "queued", syncedAt: null, enrichment: arriving });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("importing your stars"));
    expect(strip()).toContain("6 of 10");
    const bar = page().getByRole("progressbar", { name: "importing your stars" });
    expect([
      bar.getAttribute("aria-valuemin"),
      bar.getAttribute("aria-valuenow"),
      bar.getAttribute("aria-valuemax"),
    ]).toEqual(["0", "6", "10"]);
    expect(bar.getAttribute("aria-valuetext")).toBe("6 of 10 imported");
    await waitFor(() => expect(mark()).toBe("happy"));
    await waitFor(() =>
      expect(
        page().getAllByText((_, element) => element?.tagName === "H2" && /stars so far/.test(element.textContent ?? ""))
          .length,
      ).toBeGreaterThan(0),
    );
    expect(document.querySelectorAll("ol[aria-busy=true] > li").length).toBe(8);
    expect(document.querySelectorAll("ol > li > [aria-busy=true]").length).toBe(2);
  });

  test("reading: the rail follows the read count and the library shows unread repos by their description", async () => {
    server.status = status({ enrichment: reading });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("reading your stars"));
    expect(strip()).toContain("4 of 6 understood");
    const bar = page().getByRole("progressbar", { name: "reading your stars" });
    expect([
      bar.getAttribute("aria-valuenow"),
      bar.getAttribute("aria-valuemax"),
      bar.getAttribute("aria-valuetext"),
    ]).toEqual(["4", "6", "4 of 6 read"]);
    await waitFor(() => expect(mark()).toBe("thinking"));
    await waitFor(() => expect(page().getByText("A debugger for async rust.")).toBeTruthy());
    expect(page().queryAllByText("not read yet")).toEqual([]);
  });

  test("an unread repo in search results carries a not read yet chip", async () => {
    server.status = status({ enrichment: reading });
    await open("/?q=async");
    const card = await waitFor(() => page().getByRole("link", { name: "console" }).closest("article"));
    expect(card?.textContent).toContain("not read yet");
    expect(card?.textContent).toContain("A debugger for async rust.");
  });

  test("a sync on a library that synced before checks quietly, then reads new stars in place", async () => {
    server.status = status({ state: "queued", enrichment: allRead });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("checking for new stars"));
    expect(rail()).toBeNull();
    expect(page().queryByText(/still arriving/)).toBeNull();

    const fresh = repo(7, "NVIDIA", "auto-ontology", "", {
      description: null,
      summary: null,
      stars: null,
      pushedAt: null,
      read: false,
      starredAt: "2026-11-05T09:00:00.000Z",
    });
    server.repos = [fresh, ...server.repos];
    server.status = status({ state: "queued", enrichment: { total: 7, read: 6, failed: 0 } });
    await waitFor(() => expect(strip()).toContain("1 new star · reading…"), { timeout: 8000 });
    const card = page().getByRole("link", { name: "auto-ontology" }).closest("article");
    expect(card?.textContent).toContain("reading…");
    expect(card?.textContent).not.toContain("no pushes yet");

    server.repos = server.repos.map((entry) =>
      entry.id === fresh.id
        ? {
            ...entry,
            description: "A semantic layer.",
            summary: "A semantic layer.",
            stars: 6400,
            pushedAt: "2026-11-05T08:00:00.000Z",
            read: true,
          }
        : entry,
    );
    server.status = status({ enrichment: { total: 7, read: 7, failed: 0 } });
    await waitFor(() => expect(page().getByText("A semantic layer.")).toBeTruthy(), { timeout: 8000 });
    expect(strip()).toContain("7 stars");
  }, 20_000);

  test("a sync that starts after the page settled is picked up when the tab is shown again", async () => {
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("6 stars"));
    server.status = status({ state: "queued", enrichment: allRead });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(strip()).toContain("checking for new stars"));
  });

  test("the live region announces the state, not every count the poll brings", async () => {
    server.viewer = { ...server.viewer, starredCount: 10 };
    server.status = status({ state: "queued", syncedAt: null, enrichment: arriving });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("6 of 10"));
    expect(announced()).toBe("importing your stars");
    server.repos = [...server.repos, repo(7, "charmbracelet", "bubbletea", "A TUI framework.")];
    await waitFor(() => expect(strip()).toContain("7 of 10"), { timeout: 5000 });
    expect(announced()).toBe("importing your stars");
  });

  test("a failed check on a synced library says so and offers a retry", async () => {
    server.status = status({ state: "failed" });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("couldn't check for new stars"));
    expect(within(tile()).getByRole("button", { name: "try again" })).toBeTruthy();
    await waitFor(() => expect(mark()).toBe("scared"));
  });

  test("checking for new stars doesn't reload the library on every poll", async () => {
    server.status = status({ state: "queued", enrichment: allRead });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("checking for new stars"));
    const polls = server.calls.syncStatus;
    const loads = server.calls.library;
    await settle(4500);
    expect(server.calls.syncStatus).toBeGreaterThan(polls);
    expect(server.calls.library).toBe(loads);
  }, 10_000);

  test("a hidden tab stops polling and checks at once when shown", async () => {
    server.status = status({ state: "queued", syncedAt: null, enrichment: arriving });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("importing your stars"));
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await settle(2200);
      const polls = server.calls.syncStatus;
      await settle(2500);
      expect(server.calls.syncStatus).toBe(polls);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(server.calls.syncStatus).toBe(polls + 1), { timeout: 500 });
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  }, 10_000);

  test("changing the sort keeps the library still instead of replaying its entrance", async () => {
    using played = entrances();
    const user = userEvent.setup();
    await open("/", "Search your stars", false);
    await waitFor(() => expect(page().getByRole("link", { name: "tui-rs" })).toBeTruthy());
    await settle(50);
    const before = played.of(/tui-rs|ratatui|bottom/);
    expect(before).toBeGreaterThan(0);
    await user.click(within(tile()).getByRole("button", { name: /Sort by/ }));
    await user.click(await page().findByRole("menuitemradio", { name: "most stars" }));
    await waitFor(() => expect(within(tile()).getByRole("button", { name: "Sort by most stars" })).toBeTruthy());
    expect(page().getAllByRole("link", { name: /tui-rs|ratatui|bottom/ }).length).toBeGreaterThan(0);
    expect(played.of(/tui-rs|ratatui|bottom/)).toBe(before);
  });

  test("searching while reading: grouped results and a partial count", async () => {
    server.status = status({ enrichment: reading });
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/?q=terminal");
    await waitFor(() => expect(strip()).toMatch(/found \d so far/));
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "matching meaning 1 from the 4 read so far" })).toBeTruthy(),
    );
    expect(page().getByRole("heading", { name: "matching words 2 from all 6" })).toBeTruthy();
    expect(strip()).toContain("2 stars not read yet");
  });

  test("typing on keeps the results on screen instead of blanking and replaying them", async () => {
    const user = userEvent.setup();
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/?q=terminal");
    const tile = await waitFor(() => page().getByRole("link", { name: "tui-rs" }).closest("li"));
    using played = entrances();
    await user.type(page().getByRole("searchbox"), "s");
    expect(tile?.isConnected).toBe(true);
    await waitFor(() => expect(server.searches.at(-1)).toBe("terminals"));
    expect(tile?.isConnected).toBe(true);
    expect(played.of(/./)).toBe(0);
  });

  test("the header mark stays calm while you type and is surprised once, after the results settle", async () => {
    const user = userEvent.setup();
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("6 stars"));
    const poses: Array<string | null | undefined> = [mark()];
    const watch = new MutationObserver(() => poses.push(mark()));
    watch.observe(document.body, { subtree: true, attributeFilter: ["data-pose"] });
    try {
      await user.type(page().getByRole("searchbox"), "term");
      const typed = performance.now();
      await waitFor(() => expect(mark()).toBe("surprised"), { timeout: 2000 });
      expect(performance.now() - typed).toBeGreaterThanOrEqual(550);
      await waitFor(() => expect(mark()).not.toBe("surprised"), { timeout: 2000 });
      await settle(800);
    } finally {
      watch.disconnect();
    }
    const flinches = poses.filter((pose, index) => pose === "surprised" && poses[index - 1] !== "surprised");
    expect(flinches.length).toBe(1);
  }, 10_000);

  test("a new query says searching, not the last answer's count, until its own answer lands", async () => {
    const user = userEvent.setup();
    let land: (results: Array<SearchResult>) => void = () => {};
    server.search = (q) =>
      q === "terminal"
        ? [hit(server.repos[4] as Repo)]
        : new Promise((resolve) => {
            land = resolve;
          });
    await open("/?q=terminal");
    await waitFor(() => expect(strip()).toContain("found 3 of 6"));
    const box = page().getByRole("searchbox");
    await user.clear(box);
    await user.type(box, "qzxvbnm");
    await waitFor(() => expect(server.searches.at(-1)).toBe("qzxvbnm"));
    expect(strip()).toContain("searching");
    expect(page().getByRole("link", { name: "tui-rs" })).toBeTruthy();
    await act(async () => land([]));
    await waitFor(() => expect(strip()).toContain("nothing found"));
  });

  test("a meaning search that failed beside keyword matches says so, and try again asks again", async () => {
    const user = userEvent.setup();
    let failures = 1;
    server.search = () => {
      if (failures-- > 0) throw answered("SERVICE_UNAVAILABLE");
      return [hit(server.repos[4] as Repo)];
    };
    await open("/?q=terminal");
    await waitFor(() => expect(shownAt(page().getByRole("status"), "desktop")).toBe("meaning search didn't answer"));
    expect(shownAt(page().getByRole("status"), "phone")).toBe("meaning failed");
    expect(shownAt(statusLine(), "desktop")).toBe("meaning search didn't answer · found 2try again");
    expect(shownAt(statusLine(), "phone")).toBe("meaning failedfound 2try again");
    await waitFor(() => expect(mark()).toBe("scared"));
    await user.click(within(tile()).getByRole("button", { name: "try again" }));
    await waitFor(() => expect(strip()).toContain("found 3 of 6"));
    expect(server.searches).toEqual(["terminal", "terminal"]);
  });

  test("a network that searched too often is asked for a breather, with a way to search again", async () => {
    server.search = () => {
      throw answered("TOO_MANY_REQUESTS");
    };
    await open("/?q=record%20terminal%20sessions%20as%20gifs");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of searches from your network" })).toBeTruthy(),
    );
    expect(strip()).toContain("taking a breather");
    expect(within(tile()).getByRole("button", { name: "try again" })).toBeTruthy();
    await waitFor(() => expect(mark()).toBe("unsure"));
  });

  test("a breather beside keyword matches is announced, and phones show it with the count and a retry", async () => {
    server.search = () => {
      throw answered("TOO_MANY_REQUESTS");
    };
    await open("/?q=terminal");
    await waitFor(() =>
      expect(shownAt(page().getByRole("status"), "desktop")).toBe("meaning search is taking a breather"),
    );
    expect(shownAt(page().getByRole("status"), "phone")).toBe("taking a breather");
    expect(shownAt(statusLine(), "phone")).toBe("taking a breatherfound 2try again");
    expect(page().getAllByRole("link", { name: /ratatui|bottom/ }).length).toBe(2);
    await waitFor(() => expect(mark()).toBe("unsure"));
  });

  test("the header links to your stars, and marks the link current only on your own page", async () => {
    await open("/?q=terminal");
    expect(page().getByRole("link", { name: "Your stars" }).getAttribute("aria-current")).toBe("page");
    expect(page().queryByRole("tablist")).toBeNull();
    cleanup();
    server.status = status({ login: "octosync" });
    await open("/octosync", "Search @octosync's stars");
    expect(page().getByRole("link", { name: "Your stars" }).getAttribute("aria-current")).toBeNull();
  });

  test("a result's link keeps the query and a view this browser saved, so it opens the same way anywhere", async () => {
    localStorage.setItem("stargrep:view", "list");
    try {
      await open("/?q=terminal");
      await waitFor(() =>
        expect(within(tile()).getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe("true"),
      );
      const href = page().getByRole("link", { name: "bottom" }).getAttribute("href") ?? "";
      expect(Object.fromEntries(new URLSearchParams(href.slice(1)))).toEqual({
        q: "terminal",
        view: "list",
        repo: "ClementTsang/bottom",
      });
    } finally {
      localStorage.removeItem("stargrep:view");
    }
  });

  test("a result's link on the demo page keeps a search someone cleared", async () => {
    const user = userEvent.setup();
    server.signedIn = false;
    server.status = status({ login: "stefanofa" });
    await open("/", "Search @stefanofa's stars");
    const box = page().getByRole<HTMLInputElement>("searchbox");
    await user.type(box, "{Backspace}".repeat(box.value.length));
    const href = (await page().findByRole("link", { name: "bottom" })).getAttribute("href") ?? "";
    expect(Object.fromEntries(new URLSearchParams(href.slice(1)))).toEqual({ q: "", repo: "ClementTsang/bottom" });
  });

  test("a closing panel keeps its repo on screen while it slides away", async () => {
    const user = userEvent.setup();
    await open("/?q=terminal");
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("heading", { level: 2, name: "bottom" });
    const blank: Array<boolean> = [];
    const watch = new MutationObserver(() => {
      const dialog = document.querySelector("[role=dialog]");
      if (dialog !== null) blank.push(dialog.querySelector("h2") === null);
    });
    watch.observe(document.body, { subtree: true, childList: true });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    watch.disconnect();
    expect(blank).not.toContain(true);
  });

  test("Forward puts the query of the page it lands on back in the search box", async () => {
    const user = userEvent.setup();
    const router = await open("/?q=terminal");
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await user.type(page().getByRole("searchbox"), "s");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "terminals" }));
    await act(async () => router.history.forward());
    await page().findByRole("dialog");
    expect(page().getByRole<HTMLInputElement>("searchbox", { hidden: true }).value).toBe("terminal");
  });

  test("closing a panel opened from the page takes its history entry back off, so Back never reopens it", async () => {
    const user = userEvent.setup();
    const router = await open("/?q=terminal");
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    expect(router.history.canGoBack()).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "terminal" }));
    expect(router.history.canGoBack()).toBe(false);
  });

  test("closing a panel a shared link opened drops the repo from the address without a new entry", async () => {
    const user = userEvent.setup();
    const router = await open("/?q=terminal&repo=ClementTsang%2Fbottom");
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "terminal" }));
    expect(page().queryByRole("dialog")).toBeNull();
    expect(router.history.length).toBe(1);
  });

  test("on the demo page an emptied search stays empty across Back and Forward", async () => {
    const user = userEvent.setup();
    server.signedIn = false;
    server.status = status({ login: "stefanofa" });
    const router = await open("/", "Search @stefanofa's stars");
    const box = () => page().getByRole<HTMLInputElement>("searchbox", { hidden: true });
    expect(box().value).toBe("terminal dashboard");
    await user.type(box(), "{Backspace}".repeat(box().value.length));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "" }));
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await user.type(box(), "async");
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "async" }));
    await act(async () => router.history.forward());
    await page().findByRole("dialog");
    expect(box().value).toBe("");
    await act(async () => router.history.back());
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    expect(box().value).toBe("async");
  });

  test("Forward to the demo page's own address brings its query back, and Back the one typed over it", async () => {
    const user = userEvent.setup();
    server.signedIn = false;
    server.status = status({ login: "stefanofa" });
    const router = await open("/", "Search @stefanofa's stars");
    const box = () => page().getByRole<HTMLInputElement>("searchbox", { hidden: true });
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await user.type(box(), `${"{Backspace}".repeat(box().value.length)}async`);
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "async" }));
    await act(async () => router.history.forward());
    await page().findByRole("dialog");
    expect(box().value).toBe("terminal dashboard");
    await act(async () => router.history.back());
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    expect(box().value).toBe("async");
  });

  test("results once everything is read: one list, a plain count, no rail", async () => {
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/?q=terminal");
    await waitFor(() => expect(strip()).toContain("found 3 of 6"));
    expect(page().queryByRole("heading", { name: /matching words/ })).toBeNull();
    expect(page().getByRole("list", { name: "Results" })).toBeTruthy();
    expect(rail()).toBeNull();
  });

  test("empty while reading: the answer could still be in the unread part", async () => {
    server.status = status({ enrichment: reading });
    await open("/?q=record%20terminal%20sessions%20as%20gifs");
    await waitFor(() => expect(page().getByRole("heading", { name: "not in the 4 i've read yet" })).toBeTruthy());
    expect(page().getByText(/it might be in the 2 stars i'm still reading/)).toBeTruthy();
    expect(strip()).toContain("nothing yet");
    await waitFor(() => expect(mark()).toBe("unsure"));
    expect(page().queryByText(/everyone/)).toBeNull();
  });

  test("empty after everything is read: a real no, with rephrasings that search again", async () => {
    const user = userEvent.setup();
    await open("/?q=record%20terminal%20sessions%20as%20gifs");
    await waitFor(() => expect(page().getByRole("heading", { name: "nothing in all 6 stars" })).toBeTruthy());
    expect(strip()).toContain("nothing found");
    expect(strip()).toContain("all 6 stars read");
    await waitFor(() => expect(mark()).toBe("sad"));
    expect(page().queryByText(/everyone/)).toBeNull();
    const chips = within(page().getByRole("list", { name: "Try other words" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["terminal"]);
    await user.click(page().getByRole("button", { name: "terminal" }));
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("terminal");
  });

  test("the sort menu and view toggle stay inside the search tile in every state", async () => {
    const states: Array<[string, () => void]> = [
      ["/", () => {}],
      ["/", () => (server.status = status({ state: "queued", syncedAt: null, enrichment: arriving }))],
      ["/?q=terminal", () => (server.status = status({ enrichment: reading }))],
      ["/?q=nothing%20like%20this", () => (server.status = status({ enrichment: reading }))],
      ["/?q=nothing%20like%20this", () => {}],
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

  test("a check for new stars that reads nothing new doesn't search again", async () => {
    server.status = status({ state: "queued", enrichment: allRead });
    await open("/?q=async");
    await waitFor(() => expect(strip()).toContain("found"));
    await waitFor(() => expect(server.searches).toEqual(["async"]));
    server.status = status({ enrichment: allRead });
    await waitFor(() => expect(strip()).toContain("of 6"), { timeout: 5000 });
    await settle(800);
    expect(server.searches).toEqual(["async"]);
  }, 10_000);

  test("when reading finishes, the flags clear and the search runs again", async () => {
    server.status = status({ enrichment: reading });
    await open("/?q=async");
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

  test("someone GitHub doesn't know: the tile and its pill stay, and the page says so", async () => {
    server.refusals["nobody-here-x"] = "LOGIN_NOT_FOUND";
    server.status = status({ login: "nobody-here-x", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/nobody-here-x", "Search @nobody-here-x's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "github has no one called @nobody-here-x" })).toBeTruthy(),
    );
    expect(strip()).toContain("no such github user");
    expect(page().getAllByRole("button", { name: /Whose stars: @nobody-here-x/ }).length).toBeGreaterThan(0);
    await waitFor(() => expect(mark()).toBe("unsure"));
  });

  test("someone waiting for an import slot sees their place in line", async () => {
    server.status = inLine();
    await open("/linewaiter", "Search @linewaiter's stars");
    await waitFor(() => expect(strip()).toContain("in line to import"));
    expect(strip()).toMatch(/3 ahead · starts in about 2[45] min/);
    expect(page().queryByRole("heading", { name: "is this you? skip the wait" })).toBeNull();
  });

  test("a visitor watching someone's stars import is offered to skip the wait as that person", async () => {
    server.signedIn = false;
    server.status = inLine();
    await open("/linewaiter", "Search @linewaiter's stars");
    await waitFor(() => expect(strip()).toContain("in line to import"));
    expect(page().getByRole("heading", { name: "is this you? skip the wait" })).toBeTruthy();
  });

  test("a full import line says so calmly and offers to try again", async () => {
    server.refusals.busyline = "SYNC_BUSY";
    server.status = status({ login: "busyline", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/busyline", "Search @busyline's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "github's line for new imports is full" })).toBeTruthy(),
    );
    expect(strip()).toContain("the import line is full");
    expect(page().getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
    expect(page().getAllByRole("button", { name: /Whose stars: @busyline/ }).length).toBeGreaterThan(0);
  });

  test("a network that asked too often is told to wait a few minutes", async () => {
    server.refusals.slowdown = "TOO_MANY_REQUESTS";
    server.status = status({ login: "slowdown", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/slowdown", "Search @slowdown's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of requests from your network" })).toBeTruthy(),
    );
    expect(strip()).toContain("taking a breather");
  });

  test("a visitor lands on the demo account with the hero, the sign-in tile and example searches", async () => {
    const user = userEvent.setup();
    server.signedIn = false;
    server.status = status({ login: "stefanofa" });
    await open("/", "Search @stefanofa's stars");
    expect(page().getByRole("heading", { level: 1, name: "search anyone's github stars in plain words" })).toBeTruthy();
    expect(page().getByRole("heading", { name: "your stars, in a minute" })).toBeTruthy();
    expect(page().getByText("live results from @stefanofa, our demo account. try any username.")).toBeTruthy();
    const chips = page().getByRole("list", { name: "Example searches" });
    await user.click(within(chips).getByRole("button", { name: "terminal recorder" }));
    expect((page().getByRole("searchbox") as HTMLInputElement).value).toBe("terminal recorder");
  });

  test("the hero keeps its boxes when an import finishes in front of a visitor", async () => {
    server.signedIn = false;
    server.status = status({
      login: "octosync",
      state: "queued",
      syncedAt: null,
      starredTotal: 10,
      enrichment: arriving,
    });
    await open("/octosync", "Search @octosync's stars");
    const hero = () => {
      const tile = page()
        .getByRole("heading", { level: 2, name: /is this you|your stars, in a minute/ })
        .closest("[data-slot=tile]") as HTMLElement;
      const subtitle = page().getByRole("heading", { level: 1 }).nextElementSibling as HTMLElement;
      return { tile: tile.className, pip: tile.firstElementChild?.className, subtitle: subtitle.className };
    };
    await waitFor(() => expect(page().getByRole("heading", { name: "is this you? skip the wait" })).toBeTruthy());
    const importing = hero();
    server.status = status({ login: "octosync", starredTotal: 6 });
    await waitFor(() => expect(page().getByRole("heading", { name: "your stars, in a minute" })).toBeTruthy(), {
      timeout: 6000,
    });
    expect(hero()).toEqual(importing);
    expect(importing.subtitle).toContain("h-[2lh]");
  });

  test("someone else's stars say whose they are", async () => {
    server.signedIn = false;
    server.status = status({
      login: "octosync",
      state: "queued",
      syncedAt: null,
      starredTotal: 10,
      enrichment: arriving,
    });
    await open("/octosync", "Search @octosync's stars");
    await waitFor(() => expect(strip()).toContain("importing @octosync's stars"));
    expect(page().getByRole("heading", { name: "is this you? skip the wait" })).toBeTruthy();
    expect(page().getByRole("progressbar", { name: "importing @octosync's stars" })).toBeTruthy();
  });

  test("a network that read too many stars is told to wait a minute", async () => {
    library = real.makeLibrary(() => real.onePage(Promise.reject(answered("TOO_MANY_REQUESTS"))));
    await open("/", "Search your stars", false);
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of requests from your network" })).toBeTruthy(),
    );
    expect(page().getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(strip()).toContain("taking a breather");
  });

  test("a sync that cannot reach github says so and offers to try again", async () => {
    server.refusals.faraway = "SERVICE_UNAVAILABLE";
    server.status = status({ login: "faraway", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/faraway", "Search @faraway's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "stargrep couldn't reach github just now" })).toBeTruthy(),
    );
    expect(strip()).toContain("couldn't reach github");
    expect(page().getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });
});
