import "./client-branch.ts";
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { createORPCErrorFromJson } from "@orpc/client";
import type { WireCode } from "@stargrep/api/errors";
import { Login } from "@stargrep/github/schemas";
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
import type {
  Client,
  LibraryRepo,
  SearchResult,
  SimilarPerson,
  SimilarRepo,
  SimilarRepos,
  SyncStatus,
  Viewer,
} from "../src/lib/rpc.ts";
import { rememberedRefusal } from "../src/lib/trouble.ts";
import type {} from "../src/routeTree.gen.ts";
import { edgeAnswers } from "./edge-answers.ts";
import { captured } from "./posthog.fake.ts";
import { syncStatus } from "./sync-status.fixture.ts";

type Repo = LibraryRepo;

interface Server {
  viewer: Viewer;
  signedIn: boolean;
  repos: Array<Repo>;
  status: SyncStatus;
  search: (q: string) => Array<SearchResult> | Promise<Array<SearchResult>>;
  searches: Array<string>;
  // Every login the page asked to sync.
  triggered: Array<string>;
  // A refusal the API answers, or the zone's rate limit turning the address away before the API sees the request.
  refusals: Record<string, "LOGIN_NOT_FOUND" | "SYNC_BUSY" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE" | "zone">;
  calls: { library: number; syncStatus: number };
  similar: (id: number) => SimilarRepos;
  // The repo IDs the page asked for similar repos of.
  similarAsked: Array<number>;
  // Every topic the page asked whether it has a page.
  topicsAsked: Array<string>;
  // The people with stars like the page's login, and every login the page asked about.
  alike: Array<SimilarPerson>;
  alikeAsked: Array<string>;
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

const api = (): Client => ({
  similarRepos: async ({ id }: { id: number }) => {
    server.similarAsked.push(id);
    return server.similar(id);
  },
  getRepo: async () => {
    throw new Error("Unexpected getRepo call");
  },
  lookupFacets: async () => {
    throw new Error("Unexpected lookupFacets call");
  },
  people: async () => {
    throw new Error("Unexpected people call");
  },
  listTopics: async () => {
    throw new Error("Unexpected listTopics call");
  },
  topic: async () => {
    throw new Error("Unexpected topic call");
  },
  topicPages: async ({ topics }: { topics: ReadonlyArray<string> }) => {
    server.topicsAsked.push(...topics);
    return { pages: topics.filter((topic) => topic === "tui").map((topic) => ({ topic, page: topic })) };
  },
  starLanguages: async () => {
    throw new Error("Unexpected starLanguages call");
  },
  taste: async () => {
    throw new Error("Unexpected taste call");
  },
  similarPeople: async ({ login }: { login: string }) => {
    server.alikeAsked.push(login);
    return { people: server.alike };
  },
  monthlyPicks: async () => {
    throw new Error("Unexpected monthlyPicks call");
  },
  follow: async () => {
    throw new Error("Unexpected follow call");
  },
  unfollow: async () => {
    throw new Error("Unexpected unfollow call");
  },
  followedLogins: async () => {
    throw new Error("Unexpected followedLogins call");
  },
  followedPeople: async () => {
    throw new Error("Unexpected followedPeople call");
  },
  followingFeed: async () => {
    throw new Error("Unexpected followingFeed call");
  },
  githubFollowing: async () => {
    throw new Error("Unexpected githubFollowing call");
  },
  followedStarrers: async () => {
    throw new Error("Unexpected followedStarrers call");
  },
  newToYou: async () => {
    throw new Error("Unexpected newToYou call");
  },
  setMonthlyPicks: async () => {
    throw new Error("Unexpected setMonthlyPicks call");
  },
  viewer: async () => {
    if (!server.signedIn) throw new Error("signed out");
    return server.viewer;
  },
  library: async () => {
    server.calls.library += 1;
    return { repos: server.repos, labels: {} };
  },
  syncStatus: async () => {
    server.calls.syncStatus += 1;
    return server.status;
  },
  triggerSync: async ({ login }: { login: string }) => {
    server.triggered.push(login);
    const refusal = server.refusals[login];
    if (refusal === "zone") return edgeAnswers(429).triggerSync({ login });
    if (refusal !== undefined) throw answered(refusal);
    // An import that starts queues a login the API had never seen.
    if (server.status.state === "unknown")
      server.status = status({ login, state: "queued", syncedAt: null, enrichment: server.status.enrichment });
    return server.status;
  },
  stars: async ({ login }: { login: string }) => ({ login, repos: server.repos, nextCursor: null, labels: {} }),
  config: async () => ({
    demoLogin: Login.make("stefanofa"),
    demoQuery: "terminal dashboard",
    examples: ["python package manager", "terminal recorder", "fuzzy finder"],
    featured: [Login.make("stefanofa")],
    curated: [Login.make("karpathy"), Login.make("simonw")],
  }),
  search: async ({ q }: { q: string }) => {
    server.searches.push(q);
    return { planSource: "model", results: await server.search(q), applied: [] };
  },
});

let library: real.Library;

configure({ asyncUtilTimeout: 4000 });

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api }));
mock.module("../src/lib/library-collection.ts", () => ({ ...real, getLibrary: () => library }));
const setHost = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

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
  atoms: [],
  keywords: [],
  starredAt: `2026-10-${String(10 + id).padStart(2, "0")}T00:00:00.000Z`,
  stars: 1000 * id,
  icon: null,
  ownerType: "user",
  ownerAvatarUrl: null,
  read: true,
  gone: false,
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

const reading = { total: 6, read: 4, failed: 0, queued: 0 };
const allRead = { total: 6, read: 6, failed: 0, queued: 0 };
const arriving = { total: 6, read: 0, failed: 0, queued: 0 };

const status = (extra: Partial<Server["status"]>): Server["status"] => syncStatus({ enrichment: allRead, ...extra });
const near = ({ atoms, keywords, starredAt, read, ...rest }: Repo): SimilarRepo => rest;

const nobody = { people: [], total: 0 };
const nothingNear: SimilarRepos = { starredBy: nobody, inStars: [], notStarred: [] };
const hit = (repo: Repo): SearchResult => ({ ...repo, facets: [], reason: "meaning match", rankedBy: [], metrics: [] });

beforeEach(() => {
  server = {
    viewer: { login: "junodev", name: null, avatarUrl: null, starredCount: 6 },
    signedIn: true,
    repos: repos(),
    status: status({ enrichment: allRead }),
    search: () => [],
    searches: [],
    triggered: [],
    refusals: {},
    calls: { library: 0, syncStatus: 0 },
    similar: () => nothingNear,
    similarAsked: [],
    topicsAsked: [],
    alike: [],
    alikeAsked: [],
  };
  library = real.makeLibrary(() =>
    real.onePage(
      api()
        .library()
        .then(({ repos }) => repos),
    ),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  captured.length = 0;
  setHost("http://localhost/");
});

const mount = (path: string) => {
  // The root route loads the session, as the Worker does for the first page.
  const root = createRootRoute({
    component: Outlet,
    loader: async () => ({
      viewer: server.signedIn ? server.viewer : null,
      config: await api().config(),
      repoStars: null,
      discover: "people",
    }),
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
  return router;
};

const open = async (path: string, label: string | RegExp = "Search your stars", settle = true) => {
  const router = mount(path);
  await page().findByRole("searchbox", { name: label });
  if (settle) await waitFor(() => expect(document.querySelector("main > [aria-busy]")).toBeNull());
  return router;
};

const headline = "search anyone's starred GitHub repos in plain words";

// A visitor's /, which has no search box.
const landing = async () => {
  server.signedIn = false;
  const router = mount("/");
  await page().findByRole("heading", { level: 1, name: headline });
  return router;
};

const tile = () => page().getByRole("searchbox").closest("[data-slot=tile]") as HTMLElement;
// The strip's live region: the answer, or what went wrong.
const answer = () => tile().querySelector("[role=status]") as HTMLElement;
const strip = () => answer()?.textContent ?? "";
const starsTab = () => page().queryByRole("link", { name: /^stars/ })?.textContent;
// What one breakpoint shows of an element: its text without the parts that breakpoint hides.
const shownAt = (element: Element, width: "phone" | "desktop") => {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(width === "phone" ? '[class~="max-sm:hidden"]' : '[class~="sm:hidden"]'))
    hidden.remove();
  return copy.textContent ?? "";
};
const rail = () => page().queryByRole("progressbar");
const mark = () => document.querySelector("header svg[data-pose]")?.getAttribute("data-pose");
const chips = () =>
  page()
    .queryAllByText("not read yet")
    .filter((chip) => chip.checkVisibility?.() ?? true);

const poll = () =>
  act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

describe("the search page in each state", () => {
  test("browsing a synced library: the stars tab counts it, the strip says nothing, the controls sit in the tile", async () => {
    await open("/", "Search your stars", false);
    await waitFor(() => expect(starsTab()).toBe("stars6"));
    expect(strip()).toBe("");
    expect(within(tile()).getByRole("button", { name: /Sort by/ })).toBeTruthy();
    expect(within(tile()).getByRole("group", { name: "View" })).toBeTruthy();
    expect(rail()).toBeNull();
    await waitFor(() => expect(mark()).toBe("idle"));
  });

  test("the language filter marks only the chosen language current", async () => {
    const user = userEvent.setup();
    await open("/", "Search your stars", false);
    const filter = await waitFor(() => page().getByRole("navigation", { name: "Filter stars" }));
    const current = () =>
      within(filter)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent);
    await waitFor(() => expect(current()).toEqual(["all"]));
    await user.click(within(filter).getByRole("link", { name: /^Rust/ }));
    await waitFor(() => expect(current()).toEqual(["Rust 6"]));
  });

  test("importing: real counts on the rail, quiet live region, and placeholders where stars will land", async () => {
    server.viewer = { ...server.viewer, starredCount: 10 };
    server.status = status({ state: "queued", syncedAt: null, enrichment: arriving });
    await open("/", "Search your stars", false);
    const bar = await page().findByRole("progressbar", { name: "importing your stars" });
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
    expect(page().getByRole("heading", { level: 1, name: "@junodev" }).parentElement?.textContent).toContain(
      "stars arriving",
    );
    expect(starsTab()).toBe("stars");
    server.repos = [...server.repos, repo(7, "charmbracelet", "bubbletea", "A TUI framework.")];
    await poll();
    await waitFor(() => expect(bar.getAttribute("aria-valuetext")).toBe("7 of 10 imported"));
    expect(strip()).toBe("");
  });

  test("reading: the rail follows the read count and the library shows unread repos by their description", async () => {
    server.status = status({ enrichment: reading });
    await open("/", "Search your stars", false);
    const bar = await page().findByRole("progressbar", { name: "reading your stars" });
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
    await waitFor(() => expect(starsTab()).toBe("stars6"));
    expect(strip()).toBe("");
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
    server.status = status({ state: "queued", enrichment: { total: 7, read: 6, failed: 0, queued: 0 } });
    await poll();
    const card = (await page().findByRole("link", { name: "auto-ontology" })).closest("article");
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
    server.status = status({ enrichment: { total: 7, read: 7, failed: 0, queued: 0 } });
    await poll();
    await waitFor(() => expect(page().getByText("A semantic layer.")).toBeTruthy());
    expect(starsTab()).toBe("stars7");
  });

  test("your own page asks for a sync as it opens, and someone else's synced stars never ask", async () => {
    await open("/");
    await waitFor(() => expect(server.triggered).toEqual(["junodev"]));
    cleanup();
    server.status = status({ login: "octodone" });
    await open("/octodone", "Search @octodone's stars");
    await poll();
    expect(server.triggered).toEqual(["junodev"]);
  });

  test("a refused ask on your own page keeps your stars on screen, with no trouble in their place", async () => {
    server.refusals.junodev = "zone";
    await open("/");
    await waitFor(() => expect(server.triggered).toEqual(["junodev"]));
    await waitFor(() => expect(starsTab()).toBe("stars6"));
    expect(page().queryByRole("heading", { name: "lots of requests from your network" })).toBeNull();
    expect(rememberedRefusal(document.cookie, "junodev")).toBeUndefined();
  });

  test("a sync that starts after the page settled is picked up when the tab is shown again", async () => {
    await open("/", "Search your stars", false);
    await waitFor(() => expect(starsTab()).toBe("stars6"));
    server.repos = [repo(7, "charmbracelet", "bubbletea", "A TUI framework."), ...server.repos];
    server.status = status({ state: "queued", enrichment: { total: 7, read: 7, failed: 0, queued: 0 } });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(starsTab()).toBe("stars7"));
  });

  test("a failed check on a synced library says so and offers a retry", async () => {
    server.status = status({ state: "failed" });
    await open("/", "Search your stars", false);
    await waitFor(() => expect(strip()).toContain("couldn't check for new stars"));
    expect(within(tile()).getByRole("button", { name: "try again" })).toBeTruthy();
    await waitFor(() => expect(mark()).toBe("scared"));
  });

  test("changing the sort keeps the library still instead of replaying its entrance", async () => {
    using played = entrances();
    const user = userEvent.setup();
    await open("/", "Search your stars", false);
    await waitFor(() => expect(page().getByRole("link", { name: "tui-rs" })).toBeTruthy());
    await waitFor(() => expect(played.of(/tui-rs|ratatui|bottom/)).toBeGreaterThan(0));
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
    await waitFor(() => expect(starsTab()).toBe("stars6"));
    const poses: Array<string | null | undefined> = [mark()];
    const watch = new MutationObserver(() => poses.push(mark()));
    watch.observe(document.body, { subtree: true, attributeFilter: ["data-pose"] });
    try {
      await user.type(page().getByRole("searchbox"), "term");
      await waitFor(() => expect(mark()).toBe("surprised"), { timeout: 2000 });
      await waitFor(() => expect(mark()).not.toBe("surprised"), { timeout: 2000 });
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
    await waitFor(() => expect(strip()).toBe("found 3!"));
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
    await waitFor(() => expect(shownAt(answer(), "desktop")).toBe("found 2 · meaning search didn't answer"));
    expect(shownAt(answer(), "phone")).toBe("found 2 · meaning failed");
    await waitFor(() => expect(mark()).toBe("scared"));
    await user.click(within(tile()).getByRole("button", { name: "try again" }));
    await waitFor(() => expect(strip()).toBe("found 3!"));
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
    await waitFor(() => expect(shownAt(answer(), "desktop")).toBe("found 2 · meaning search is taking a breather"));
    expect(shownAt(answer(), "phone")).toBe("found 2 · taking a breather");
    expect(within(tile()).getByRole("button", { name: "try again" })).toBeTruthy();
    expect(page().getAllByRole("link", { name: /ratatui|bottom/ }).length).toBe(2);
    await waitFor(() => expect(mark()).toBe("unsure"));
  });

  test("a visitor's home lights home and leaves sign-in to the butter tile on phones, and someone's stars light nothing", async () => {
    const signIn = () =>
      within(page().getAllByRole("banner")[0] as HTMLElement).getByRole("button", { name: "sign in" });
    const bar = () => document.querySelector("[data-slot=tab-bar]") as HTMLElement;
    await landing();
    expect(within(bar()).getByRole("link", { name: "home" }).getAttribute("aria-current")).toBe("page");
    expect(signIn().className).toContain("max-sm:hidden");
    cleanup();
    server.status = status({ login: "octosync" });
    await open("/octosync", "Search @octosync's stars");
    expect(bar().querySelector("[aria-current]")).toBeNull();
    expect(signIn().className).not.toContain("max-sm:hidden");
  });

  test("the search box's example speaks as the viewer only on their own stars", async () => {
    await open("/");
    expect(page().getByRole("searchbox").getAttribute("placeholder")).toBe("the rust tui library i starred last year");
    cleanup();
    server.status = status({ login: "octosync" });
    await open("/octosync", "Search @octosync's stars");
    expect(page().getByRole("searchbox").getAttribute("placeholder")).toBe("search @octosync's stars");
  });

  test("a result's link keeps the query and a view this browser saved, so it opens the same way anywhere", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test saves a view the way the page does.
    document.cookie = "stargrep-view=list; Path=/";
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
      // biome-ignore lint/suspicious/noDocumentCookie: the test clears the view it saved.
      document.cookie = "stargrep-view=; Max-Age=0; Path=/";
    }
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

  test("closing a panel reopened with Forward goes back over the same entry, so Back never shows it twice", async () => {
    const user = userEvent.setup();
    const router = await open("/?q=terminal");
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await act(async () => router.history.forward());
    await page().findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "terminal" }));
    expect(router.history.canGoBack()).toBe(false);
  });

  test("a panel opened by a click still closes back to its page after the page remounts", async () => {
    const user = userEvent.setup();
    const router = await open("/?q=terminal");
    await user.click(await page().findByRole("link", { name: "bottom" }));
    await page().findByRole("dialog");
    cleanup();
    render(<RouterProvider router={router} />);
    await page().findByRole("dialog");
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

  test("results once everything is read: one list, a plain count, no rail", async () => {
    server.search = () => [hit(server.repos[4] as Repo)];
    await open("/?q=terminal");
    await waitFor(() => expect(strip()).toBe("found 3!"));
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
    expect(strip()).toBe("nothing found");
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
    await poll();
    await waitFor(() => expect(strip()).toBe("found 1!"));
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
    await poll();
    await waitFor(() => expect(server.searches.length).toBe(before + 1));
    expect(server.searches.at(-1)).toBe("async");
    await waitFor(() => expect(chips()).toEqual([]));
    expect(strip()).not.toContain("so far");
  }, 15_000);

  test("a first search before the import creates the account waits for the import instead of failing", async () => {
    const created = { account: false };
    server.signedIn = false;
    server.repos = [];
    server.status = status({
      login: "newcomer",
      state: "unknown",
      syncedAt: null,
      requestedAt: null,
      enrichment: { total: 0, read: 0, failed: 0, queued: 0 },
    });
    server.search = () => {
      if (!created.account) throw answered("ACCOUNT_NOT_SYNCED");
      return [hit(repos()[0] as Repo)];
    };
    await open("/newcomer?q=terminal", "Search @newcomer's stars");
    await waitFor(() => expect(server.searches).toEqual(["terminal"]));
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "i haven't read @newcomer's stars yet" })).toBeTruthy(),
    );
    expect(page().getByText("i'll search again when reading finishes")).toBeTruthy();
    expect(strip()).not.toContain("didn't answer");

    created.account = true;
    server.repos = repos().map((entry) => ({ ...entry, read: true }));
    server.status = status({ login: "newcomer", starredTotal: 6, enrichment: allRead });
    await poll();
    await waitFor(() => expect(server.searches).toEqual(["terminal", "terminal"]));
    await waitFor(() => expect(strip()).toContain("found"));
  }, 15_000);

  test("someone GitHub doesn't know: the person keeps their handle, and the page says so", async () => {
    server.refusals["nobody-here-x"] = "LOGIN_NOT_FOUND";
    server.status = status({ login: "nobody-here-x", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/nobody-here-x", "Search @nobody-here-x's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "GitHub has no one called @nobody-here-x" })).toBeTruthy(),
    );
    expect(page().getByText("check the spelling, or pick someone from people.")).toBeTruthy();
    expect(page().getByRole("link", { name: "see people" }).getAttribute("href")).toBe("/people");
    expect(page().getByRole("heading", { level: 1, name: "@nobody-here-x" })).toBeTruthy();
    expect(page().queryByRole("button", { name: "share" })).toBeNull();
    expect(page().queryByRole("link", { name: "on GitHub ↗" })).toBeNull();
    await waitFor(() => expect(mark()).toBe("unsure"));
  });

  test("a full import line says so calmly and offers to try again", async () => {
    server.refusals.busyline = "SYNC_BUSY";
    server.status = status({ login: "busyline", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/busyline", "Search @busyline's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "github's line for new imports is full" })).toBeTruthy(),
    );
    expect(page().getAllByRole("button", { name: "try again" }).length).toBeGreaterThan(0);
  });

  test("a network that asked too often is told to wait a few minutes", async () => {
    server.refusals.slowdown = "TOO_MANY_REQUESTS";
    server.status = status({ login: "slowdown", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/slowdown", "Search @slowdown's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of requests from your network" })).toBeTruthy(),
    );
  });

  test("an address the zone turned away is told to wait, not that github is out of reach, and only for a minute", async () => {
    server.refusals.flooded = "zone";
    server.status = status({ login: "flooded", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/flooded", "Search @flooded's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of requests from your network" })).toBeTruthy(),
    );
    expect(page().getAllByRole("button", { name: "try again" }).length).toBeGreaterThan(0);
    expect(rememberedRefusal(document.cookie, "flooded")).toBe("limited");
    try {
      setSystemTime(DateTime.toEpochMillis(DateTime.add(DateTime.nowUnsafe(), { seconds: 61 })));
      expect(rememberedRefusal(document.cookie, "flooded")).toBeUndefined();
    } finally {
      setSystemTime();
    }
  });

  test("a visitor's home shows one search someone could run, painted from its answer and linked to it", async () => {
    server.search = () => [hit(server.repos[0] as Repo), hit(server.repos[1] as Repo)];
    server.status = status({ login: "stefanofa", starredTotal: 1234 });
    await landing();
    expect(page().queryByRole("searchbox")).toBeNull();
    expect(page().getByRole("heading", { name: "get your own page" })).toBeTruthy();
    const example = page().getByRole("link", { name: '"terminal dashboard"' });
    const tile = example.closest("[data-slot=tile]") as HTMLElement;
    expect(example.getAttribute("href")).toBe("/stefanofa?q=terminal+dashboard");
    expect(shownAt(tile, "desktop")).toContain("for example, in @stefanofa's 1,234 stars");
    expect(shownAt(tile, "phone")).toContain("for example, in @stefanofa's stars");
    expect(tile.querySelector("h2")?.textContent).toBe('"terminal dashboard" found 2!');
    expect(
      Array.from(tile.querySelectorAll("li"), (repo) => repo.querySelector("span:not([data-slot])")?.textContent),
    ).toEqual(["ratatui", "bottom"]);
    expect(Array.from(tile.querySelectorAll("mark"), (mark) => mark.textContent)).toEqual([
      "terminal",
      "dashboard",
      "dashboard",
      "terminal",
    ]);
    // The example is the one search the page asks for.
    expect(server.searches).toEqual(["terminal dashboard"]);
    const footer = page().getByRole("contentinfo");
    const maker = within(footer).getByRole("link", { name: "@stefanofa" });
    expect(maker.parentElement?.textContent).toBe("made by @stefanofa");
    expect([maker.getAttribute("href"), maker.getAttribute("target")]).toEqual(["https://x.com/stefanofa", "_blank"]);
  });

  test("a visitor's home without an answer to show still offers the search, without a count", async () => {
    server.search = () => [];
    await landing();
    const example = page().getByRole("link", { name: '"terminal dashboard"' });
    const tile = example.closest("[data-slot=tile]") as HTMLElement;
    expect(tile.querySelector("h2")?.textContent).toBe('"terminal dashboard"');
    expect(tile.querySelectorAll("li")).toHaveLength(0);
  });

  test("a visitor types any username on the landing and lands on that login's stars", async () => {
    const user = userEvent.setup();
    const router = await landing();
    await user.type(page().getByRole("textbox", { name: "github.com/ username" }), " @octodone ");
    await user.click(within(page().getByRole("form", { name: "Whose stars" })).getByRole("button", { name: "go" }));
    await page().findByRole("searchbox", { name: "Search @octodone's stars" });
    expect(router.state.location.pathname).toBe("/octodone");
    // A person page has the person in place of the landing, so the field leaves with it.
    expect(page().getByRole("heading", { level: 1, name: "@octodone" })).toBeTruthy();
    expect(page().queryByRole("textbox", { name: "github.com/ username" })).toBeNull();
  });

  test("the landing's username field stays put on something GitHub could not call a login", async () => {
    const user = userEvent.setup();
    const router = await landing();
    await user.type(page().getByRole("textbox", { name: "github.com/ username" }), "not a login");
    await user.click(within(page().getByRole("form", { name: "Whose stars" })).getByRole("button", { name: "go" }));
    expect(router.state.location.pathname).toBe("/");
    expect(page().getByRole("heading", { level: 1, name: headline })).toBeTruthy();
  });

  test("a person page says since when and how lately they star, what they mostly star, and the count once", async () => {
    setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T00:00:00.000Z")));
    try {
      server.signedIn = false;
      server.status = status({ login: "octodone" });
      server.repos = repos().map((entry) =>
        entry.id <= 4
          ? { ...entry, topics: entry.id === 4 ? ["tui"] : ["tui", "terminal"] }
          : { ...entry, topics: ["rust"] },
      );
      await open("/octodone", "Search @octodone's stars");
      const person = page().getByRole("heading", { level: 1, name: "@octodone" }).closest("[data-slot=tile]");
      if (!(person instanceof HTMLElement)) throw new Error("no person tile");
      await waitFor(() =>
        expect(shownAt(person, "desktop")).toContain("starring since 2026 · last starred Oct 16 · on GitHub ↗"),
      );
      expect(shownAt(person, "phone")).toContain("since 2026 · last starred Oct 16");
      expect(shownAt(person, "phone")).not.toContain("on GitHub");
      expect(person.querySelector("img")?.getAttribute("src")).toBe("https://github.com/octodone.png?size=192");
      await waitFor(() =>
        expect(within(person).getByRole("link", { name: "tui" }).getAttribute("href")).toBe("/topics/tui"),
      );
      expect(within(person).getByText("terminal").closest("a")).toBeNull();
      expect(shownAt(person, "desktop")).toContain("mostlytuiterminalrust");
      const tabs = within(page().getByRole("navigation", { name: "@octodone's page" })).getAllByRole("link");
      expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-current"), tab.getAttribute("href")])).toEqual([
        ["stars6", "page", "/octodone"],
        ["taste", null, "/@octodone/taste"],
        ["people", null, "/@octodone/people"],
      ]);
      expect(
        within(person)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["share", "+ follow"]);
      cleanup();
      server.signedIn = true;
      server.status = status({});
      await open("/");
      const own = within(page().getByRole("navigation", { name: "your page" })).getByRole("link", { name: /^stars/ });
      await waitFor(() => expect(own.textContent).toBe("stars6"));
      expect(own.getAttribute("href")).toBe("/");
      expect(page().queryByRole("button", { name: "+ follow" })).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("share copies the person's /@login address with the search on screen, and says so for a moment", async () => {
    const user = userEvent.setup();
    setHost("https://stargrep.com/octodone?q=terminal");
    const copied: Array<string> = [];
    using _ = spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      copied.push(text);
    });
    server.signedIn = false;
    server.status = status({ login: "octodone" });
    await open("/octodone?q=terminal", "Search @octodone's stars");
    await user.click(page().getByRole("button", { name: "share" }));
    await waitFor(() => expect(copied).toEqual(["https://stargrep.com/@octodone?q=terminal"]));
    expect(page().getByRole("button", { name: "link copied" })).toBeTruthy();
    expect(
      page()
        .getAllByRole("status")
        .some((status) => status.textContent === "link copied"),
    ).toBe(true);
    await waitFor(() => expect(captured).toContainEqual(["person_shared", { via: "link" }]));
    await waitFor(() => expect(page().getByRole("button", { name: "share" })).toBeTruthy(), { timeout: 3000 });
  });

  test("an answer offers the same words on the stars of people like this person, and browsing offers nothing", async () => {
    server.signedIn = false;
    server.status = status({ login: "octoask" });
    const alike = (login: string, topics: Array<string>): SimilarPerson => ({
      login,
      avatarUrl: null,
      curated: false,
      stars: 100,
      lastStarredAt: "2026-11-01T00:00:00.000Z",
      languages: [],
      topics,
      shared: 12,
    });
    server.alike = [
      alike("orhun", ["rust", "tui"]),
      alike("antfu", []),
      ...["a", "b", "c"].map((login) => alike(login, [])),
    ];
    await open("/octoask", "Search @octoask's stars");
    expect(server.alikeAsked).toEqual([]);
    cleanup();
    server.search = () => [hit(server.repos[0] as Repo)];
    await open("/octoask?q=rust tui", "Search @octoask's stars");
    const row = (await page().findByRole("heading", { name: "same question in" })).parentElement as HTMLElement;
    expect(
      within(row)
        .getAllByRole("link")
        .map((link) => [shownAt(link, "desktop"), link.getAttribute("href")]),
    ).toEqual([
      ["@orhunmostly rust", "/@orhun?q=rust+tui"],
      ["@antfu", "/@antfu?q=rust+tui"],
      ["@a", "/@a?q=rust+tui"],
      ["@b", "/@b?q=rust+tui"],
    ]);
    expect(server.alikeAsked).toEqual(["octoask"]);
  });

  test("the chips count the answer on screen and filter it, and the answer keeps its count", async () => {
    const user = userEvent.setup();
    server.repos = repos().map((entry) => (entry.name === "bottom" ? { ...entry, language: "Go" } : entry));
    server.search = () => [hit(server.repos[4] as Repo)];
    const router = await open("/?q=terminal");
    await waitFor(() => expect(strip()).toBe("found 3!"));
    const filters = within(page().getByRole("navigation", { name: "Filter stars" }));
    expect(filters.getAllByRole("link").map((link) => link.textContent)).toEqual(["all", "Rust 2", "Go 1"]);
    await user.click(filters.getByRole("link", { name: "Go 1" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "terminal", lang: "Go" }));
    await waitFor(() =>
      expect(
        page()
          .getAllByRole("article")
          .map((article) => within(article).getByRole("heading").textContent),
      ).toEqual(["bottom"]),
    );
    expect(strip()).toBe("found 3!");
  });

  test("someone else's stars say whose they are, and hold the place of stars still on their way", async () => {
    server.signedIn = false;
    server.repos = [];
    server.status = status({
      login: "octosync",
      state: "queued",
      syncedAt: null,
      starredTotal: 10,
      enrichment: arriving,
    });
    await open("/octosync", "Search @octosync's stars");
    expect(await page().findByRole("progressbar", { name: "importing @octosync's stars" })).toBeTruthy();
    const person = page().getByRole("heading", { level: 1, name: "@octosync" }).parentElement;
    expect(person?.textContent).toContain("stars arriving");
    await waitFor(() => expect(document.querySelectorAll("ol[aria-busy=true] > li").length).toBe(8));
    expect(page().queryByRole("heading", { name: "is this you? skip the wait" })).toBeNull();
    expect(page().queryByRole("list", { name: "Example searches" })).toBeNull();
  });

  test("a network that read too many stars is told to wait a minute", async () => {
    library = real.makeLibrary(() => real.onePage(Promise.reject(answered("TOO_MANY_REQUESTS"))));
    await open("/", "Search your stars", false);
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "lots of requests from your network" })).toBeTruthy(),
    );
    expect(page().getByRole("button", { name: "try again" })).toBeTruthy();
  });

  test("a sync that cannot reach github says so and offers to try again", async () => {
    server.refusals.faraway = "SERVICE_UNAVAILABLE";
    server.status = status({ login: "faraway", state: "unknown", syncedAt: null, requestedAt: null });
    await open("/faraway", "Search @faraway's stars");
    await waitFor(() =>
      expect(page().getByRole("heading", { name: "stargrep couldn't reach GitHub just now" })).toBeTruthy(),
    );
    expect(page().getAllByRole("button", { name: "try again" }).length).toBeGreaterThan(0);
  });
});

describe("signing in", () => {
  test("signing in comes back to the page it started from", async () => {
    const user = userEvent.setup();
    server.signedIn = false;
    server.status = status({ login: "octosync" });
    const path = "/octosync?q=terminal&error=access_denied";
    history.replaceState(null, "", path);
    await open(path, "Search @octosync's stars");
    using sent = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ url: "https://github.com/login" }));
    using _ = spyOn(location, "assign").mockImplementation(() => {});
    await user.click(within(page().getByRole("alert")).getByRole("button", { name: "try again" }));
    await waitFor(() => expect(sent).toHaveBeenCalled());
    const [url, init] = sent.mock.calls[0] ?? [];
    expect([url, JSON.parse(String(init?.body))]).toEqual([
      "/auth/sign-in/social",
      { provider: "github", callbackURL: "/octosync?q=terminal", errorCallbackURL: "/octosync?q=terminal" },
    ]);
  });
});

describe("repos near the open one", () => {
  const helix = near(
    repo(99, "helix-editor", "helix", "A post-modern modal text editor.", { stars: 40_000, license: "MPL-2.0" }),
  );

  test("load once the panel opens, leave an empty row out, and open a repo the login hasn't starred in place", async () => {
    const user = userEvent.setup();
    server.similar = (id) =>
      id === 2 ? { starredBy: nobody, inStars: [near(repos()[0] as Repo)], notStarred: [helix] } : nothingNear;
    const router = await open("/?q=terminal");
    expect(server.similarAsked).toEqual([]);

    await user.click(await page().findByRole("link", { name: "bottom" }));
    const panel = within(await page().findByRole("dialog"));
    await panel.findByRole("heading", { name: "also in your stars" });
    expect(panel.getByRole("link", { name: /ratatui/ }).textContent).toContain("Widgets for terminal dashboards.");
    expect(panel.getByRole("heading", { name: "more like this" })).toBeDefined();
    expect(server.similarAsked).toEqual([2]);

    await user.click(panel.getByRole("link", { name: /helix/ }));
    await panel.findByRole("heading", { level: 2, name: "helix" });
    expect(router.state.location.search).toMatchObject({ q: "terminal", repo: "helix-editor/helix" });
    expect(panel.queryByText(/starred it/)).toBeNull();
    // The link that opened helix is gone, so focus moves to the panel.
    expect(document.activeElement).toBe(page().getByRole("dialog"));
    // helix has nothing near it in either row, so neither row shows.
    await waitFor(() => expect(server.similarAsked).toEqual([2, 99]));
    await waitFor(() => expect(panel.queryByRole("heading", { name: "also in your stars" })).toBeNull());
    expect(panel.queryByRole("heading", { name: "more like this" })).toBeNull();

    // The repo replaced the one the click opened, so closing the panel goes straight back to the page.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "terminal" }));
    expect(router.history.canGoBack()).toBe(false);
  });

  test("name the listed people who star the repo high in the panel, and a face opens their stars", async () => {
    const user = userEvent.setup();
    const people = [
      { login: "karpathy", avatarUrl: "https://avatars.githubusercontent.com/u/241138?v=4" },
      { login: "api", avatarUrl: null },
    ];
    server.similar = (id) => (id === 2 ? { ...nothingNear, starredBy: { people, total: 9 } } : nothingNear);
    const router = await open("/?q=terminal");

    await user.click(await page().findByRole("link", { name: "bottom" }));
    const panel = within(await page().findByRole("dialog"));
    const row = (await panel.findByRole("heading", { name: "also starred by" })).closest("section");
    if (row === null) throw new Error("no also starred by row");
    const faces = ["@karpathy", "@api"].map((name) => within(row).getByRole("link", { name }));
    expect(faces.map((face) => face.getAttribute("href"))).toEqual(["/karpathy", "/@api"]);
    expect(within(row).getAllByRole("link")).toHaveLength(2);
    expect(within(row).getByText("+7 more")).toBeDefined();
    // It sits above the link to GitHub, where it shows without scrolling.
    const github = panel.getByRole("link", { name: /open on GitHub/ });
    expect(row.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(faces[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe("/karpathy"));
  });

  test("leave the row out when no listed person stars the repo", async () => {
    const user = userEvent.setup();
    server.similar = (id) => (id === 2 ? { ...nothingNear, inStars: [near(repos()[0] as Repo)] } : nothingNear);
    await open("/?q=terminal");

    await user.click(await page().findByRole("link", { name: "bottom" }));
    const panel = within(await page().findByRole("dialog"));
    await panel.findByRole("heading", { name: "also in your stars" });
    expect(panel.queryByRole("heading", { name: "also starred by" })).toBeNull();
  });
});
