import { describe, expect, test } from "bun:test";
import { keywordTerms, searchText } from "../src/lib/keyword.ts";
import type { LibraryEntry } from "../src/lib/library-collection.ts";
import { mergeResults } from "../src/lib/results.ts";
import type { SearchResult } from "../src/lib/rpc.ts";

const entry = (id: number, name: string, stars: number, summary: string): LibraryEntry => {
  const repo = {
    id: id as LibraryEntry["id"],
    owner: "owner",
    name,
    url: `https://github.com/owner/${name}`,
    description: null,
    summary,
    language: "Rust",
    topics: [],
    license: null,
    kind: null,
    archived: false,
    pushedAt: "2026-11-01T00:00:00.000Z",
    keywords: [],
    starredAt: "2026-01-01T00:00:00.000Z",
    stars,
  };
  return { ...repo, text: searchText(repo) };
};

const hit = (repo: LibraryEntry, rankedBy: ReadonlyArray<string> = []): SearchResult => ({
  ...repo,
  reason: "meaning match #1",
  rankedBy: [...rankedBy],
  metrics: [],
});

const at = Date.parse("2026-11-04T00:00:00Z");
const ratatui = entry(1, "ratatui", 16_400, "Widgets for terminal dashboards.");
const tuiRs = entry(2, "tui-rs", 11_100, "Where ratatui came from.");
const bottom = entry(3, "bottom", 11_600, "A system monitor for the terminal.");
const library = new Map([ratatui, tuiRs, bottom].map((repo) => [repo.id as number, repo]));
const find = (id: number) => library.get(id);

describe("mergeResults", () => {
  test("ranks keyword matches by name first, then appends semantic hits not already shown", () => {
    const terms = keywordTerms("ratatui");
    const merged = mergeResults({
      matched: [tuiRs, ratatui],
      terms,
      hits: [hit(ratatui), hit(bottom, ["11.6K stars"]), hit({ ...bottom, id: 99 as LibraryEntry["id"] })],
      find,
      at,
    });
    expect(merged.map((result) => result.name)).toEqual(["ratatui", "tui-rs", "bottom"]);
    expect(merged[2]?.reason).toBe("A system monitor for the terminal. · 11.6K stars");
    expect(merged[0]?.matches).toEqual([]);
    expect(merged[1]?.matches).toEqual([[6, 13]]);
  });

  test("takes a semantic tile's summary from the search reply, which can be newer than the library", () => {
    const stale: LibraryEntry = { ...bottom, summary: null, description: null };
    const merged = mergeResults({
      matched: [],
      terms: [],
      hits: [hit(bottom, ["11.6K stars"])],
      find: () => stale,
      at,
    });
    expect(merged[0]?.reason).toBe("A system monitor for the terminal. · 11.6K stars");
  });

  test("shows only semantic hits when the query has no keyword", () => {
    const merged = mergeResults({ matched: [ratatui, tuiRs, bottom], terms: [], hits: [hit(bottom)], find, at });
    expect(merged.map((result) => result.name)).toEqual(["bottom"]);
  });
});
