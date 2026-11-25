import "./client-branch.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { OpenResult } from "@stargrep/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useSearch } from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterChips } from "../src/components/filter-chips.tsx";
import { LibraryView } from "../src/components/library-view.tsx";
import { searchText } from "../src/lib/keyword.ts";
import type { LibraryEntry } from "../src/lib/library-collection.ts";
import { facetOf, facetsOf, libraryFilter } from "../src/lib/library-filter.ts";
import { type Params, validateParams } from "../src/lib/search-params.ts";

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

describe("the strip's facets", () => {
  test("count each language most first, and the archived repos GitHub still serves", () => {
    const go = entry(8, "bubbletea", { language: "Go" });
    expect(facetsOf([...library, go, entry(9, "notes", { language: null })].map(facetOf))).toEqual({
      languages: [
        ["Rust", 7],
        ["Go", 1],
      ],
      archived: 4,
    });
  });
});

const show = (entries: ReadonlyArray<LibraryEntry>, path = "/") => {
  const opened: Array<string> = [];
  const onOpen: OpenResult = (result) => opened.push(`${result.owner}/${result.name}`);
  function Library() {
    const search: Params = useSearch({ strict: false });
    return (
      <>
        <FilterChips facets={facetsOf(entries.map(facetOf))} lang={search.lang} archived={search.archived === true} />
        <LibraryView
          entries={entries}
          at={Date.parse("2026-11-21T00:00:00.000Z")}
          view="tiles"
          sort="stars"
          search={search}
          arriving={undefined}
          onOpen={onOpen}
        />
      </>
    );
  }
  const root = createRootRoute({ component: Library, validateSearch: validateParams });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(<RouterProvider router={router} />);
  return { view, router, opened };
};

const shownRepos = (view: ReturnType<typeof render>) =>
  view.getAllByRole("article").map((article) => within(article).getByRole("heading").textContent);

describe("the starred and topic filters", () => {
  const tagged = library.map((repo) => (repo.id % 2 === 0 ? { ...repo, topics: ["cli", "tui"] } : repo));
  const kept = (search: string) =>
    tagged
      .filter((repo) => {
        const { lang, archived, starred, topic } = validateParams(Object.fromEntries(new URLSearchParams(search)));
        return libraryFilter(lang, archived === true, starred, topic)(repo);
      })
      .map((repo) => repo.name);

  test("keep the stars of a UTC month or day, and the repos with a topic", () => {
    expect(kept("starred=2026-10")).toHaveLength(7);
    expect(kept("starred=2026-09")).toEqual([]);
    expect(kept("starred=2026-10-12")).toEqual(["tui-rs"]);
    expect(kept("topic=cli")).toEqual(["tui-rs", "moment", "atom"]);
    expect(kept("topic=cli&starred=2026-10-14")).toEqual(["moment"]);
  });

  test("a malformed period filters nothing", () => {
    expect(validateParams({ starred: "2026-1", topic: "" })).toEqual({});
    expect(validateParams({ starred: "2026-10-12..2026-10-14" })).toEqual({});
    expect(kept("starred=last-week")).toHaveLength(7);
  });
});

describe("the archived chip among the language filters", () => {
  const filters = async (view: ReturnType<typeof render>) =>
    within(await view.findByRole("navigation", { name: "Filter stars" }));

  test("filters to the archived repos, and all takes every filter off", async () => {
    const user = userEvent.setup();
    const { view, router } = show(library, "/?lang=Rust");
    await user.click((await filters(view)).getByRole("link", { name: "archived 4" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ lang: "Rust", archived: true }));
    await waitFor(() => expect(shownRepos(view)).toEqual(["atom", "moment", "tui-rs", "request"]));
    expect((await filters(view)).getByRole("link", { name: "all" }).getAttribute("aria-current")).toBeNull();
    await user.click((await filters(view)).getByRole("link", { name: "all" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(shownRepos(view)).toHaveLength(7));
  });

  test("is left out when nothing is archived, and stays while its filter is on", async () => {
    const { view } = show([entry(1, "alive")]);
    expect((await filters(view)).getAllByRole("link").map((link) => link.textContent)).toEqual(["all", "Rust 1"]);
    cleanup();
    const shared = show([entry(1, "alive")], "/?archived=true");
    expect((await filters(shared.view)).getByRole("link", { name: "archived 0" })).toBeDefined();
  });
});
