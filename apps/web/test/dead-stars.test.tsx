import "./client-branch.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { OpenResult } from "@stargrep/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useSearch } from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryView } from "../src/components/library-view.tsx";
import { deadStars } from "../src/lib/dead-stars.ts";
import { searchText } from "../src/lib/keyword.ts";
import type { LibraryEntry } from "../src/lib/library-collection.ts";
import { type Params, validateParams } from "../src/lib/search-params.ts";
import type { Whose } from "../src/lib/whose.ts";

afterEach(cleanup);

const entry = (id: number, name: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => {
  const repo = {
    id: id as LibraryEntry["id"],
    owner: "owner",
    name,
    url: `https://github.com/owner/${name}`,
    description: `${name} does a thing.`,
    summary: null,
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
    read: true,
    gone: false,
    icon: null,
    ownerType: null,
    ownerAvatarUrl: null,
    ...extra,
  };
  return { ...repo, text: searchText(repo) };
};

const library = [
  entry(1, "alive"),
  entry(2, "tui-rs", { archived: true }),
  entry(3, "request", { archived: true, stars: null }),
  entry(4, "moment", { archived: true }),
  entry(5, "vanished", { archived: true, gone: true }),
  entry(6, "atom", { archived: true }),
  entry(7, "fresh"),
];

describe("dead stars", () => {
  test("count the archived repos GitHub still serves and pick the most starred few", () => {
    const dead = deadStars(library);
    expect(dead.count).toBe(4);
    expect(dead.top.map((repo) => repo.name)).toEqual(["atom", "moment", "tui-rs"]);
  });

  test("a library with nothing archived has none", () => {
    expect(deadStars([entry(1, "alive"), entry(2, "gone", { archived: true, gone: true })])).toEqual({
      count: 0,
      top: [],
    });
  });
});

const show = (entries: ReadonlyArray<LibraryEntry>, whose: Whose = { own: true }, path = "/") => {
  const opened: Array<string> = [];
  const onOpen: OpenResult = (result) => opened.push(`${result.owner}/${result.name}`);
  function Library() {
    const search: Params = useSearch({ strict: false });
    return (
      <LibraryView
        entries={entries}
        at={Date.parse("2026-11-21T00:00:00.000Z")}
        view="tiles"
        sort="stars"
        search={search}
        whose={whose}
        arriving={undefined}
        pose="idle"
        butter
        onOpen={onOpen}
      />
    );
  }
  const root = createRootRoute({ component: Library, validateSearch: validateParams });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(<RouterProvider router={router} />);
  return { view, router, opened };
};

const tile = () => document.querySelector("[aria-label='most starred']")?.closest("[data-slot=tile]") as HTMLElement;
const shownRepos = (view: ReturnType<typeof render>) =>
  view.getAllByRole("article").map((article) => within(article).getByRole("heading").textContent);

describe("the dead stars tile", () => {
  test("says how many of your stars are archived and shows the most starred three", async () => {
    const { view } = show(library);
    await view.findByRole("heading", { name: "dead stars" });
    expect(within(tile()).getByText("4 of your stars are archived")).toBeTruthy();
    const top = within(tile()).getByRole("list", { name: "most starred" });
    const names = within(top)
      .getAllByRole("link")
      .map((link) => Array.from(link.querySelectorAll("span > span"), (line) => line.textContent));
    expect(names).toEqual([
      ["atom", "owner · 6k stars"],
      ["moment", "owner · 4k stars"],
      ["tui-rs", "owner · 2k stars"],
    ]);
  });

  test("on someone else's page it names whose stars they are", async () => {
    const { view } = show([entry(1, "tui-rs", { archived: true })], { own: false, login: "ada" });
    expect(await view.findByText("1 of @ada's stars is archived")).toBeTruthy();
  });

  test("stays hidden when nothing is archived", async () => {
    const { view } = show([entry(1, "alive"), entry(2, "vanished", { archived: true, gone: true })]);
    await view.findByRole("heading", { name: "languages" });
    expect(view.queryByRole("heading", { name: "dead stars" })).toBeNull();
  });

  test("opens a repo in the panel from the tile", async () => {
    const user = userEvent.setup();
    const { view, opened } = show(library);
    await view.findByRole("heading", { name: "dead stars" });
    await user.click(within(tile()).getByRole("link", { name: /^atom/ }));
    expect(opened).toEqual(["owner/atom"]);
  });

  test("see all filters the library to the archived repos, and the chip takes it back", async () => {
    const user = userEvent.setup();
    const { view, router } = show(library);
    await view.findByRole("heading", { name: "dead stars" });
    expect(shownRepos(view)).toHaveLength(7);
    await user.click(within(tile()).getByRole("link", { name: "see all 4" }));
    await waitFor(() => expect(shownRepos(view)).toEqual(["atom", "moment", "tui-rs", "request"]));
    expect(router.state.location.search).toEqual({ archived: true });
    expect(view.getByRole("region", { name: "archived" })).toBeTruthy();
    await user.click(within(tile()).getByRole("link", { name: "show every star" }));
    await waitFor(() => expect(shownRepos(view)).toHaveLength(7));
  });

  test("a shared link to the filter on a library with nothing archived can still take it off", async () => {
    const user = userEvent.setup();
    const { view } = show([entry(1, "alive")], { own: true }, "/?archived=true");
    expect(await view.findByText("0 of your stars are archived")).toBeTruthy();
    await user.click(view.getByRole("link", { name: "show every star" }));
    await waitFor(() => expect(shownRepos(view)).toEqual(["alive"]));
  });

  test("a shared link to the archived filter lands on it", async () => {
    const { view } = show(library, { own: true }, "/?archived=true");
    await waitFor(() => expect(shownRepos(view)).toEqual(["atom", "moment", "tui-rs", "request"]));
  });
});
