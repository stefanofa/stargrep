import { describe, expect, test } from "bun:test";
import { searchText } from "../src/lib/keyword.ts";
import type { LibraryEntry } from "../src/lib/library-collection.ts";
import { toDetail } from "../src/lib/present.ts";

const entry = (description: string | null, summary: string | null): LibraryEntry => {
  const repo = {
    id: 1 as LibraryEntry["id"],
    owner: "ratatui",
    name: "ratatui",
    url: "https://github.com/ratatui/ratatui",
    description,
    summary,
    language: "Rust",
    topics: [],
    license: null,
    kind: null,
    archived: false,
    pushedAt: "2026-11-01T00:00:00.000Z",
    keywords: [],
    starredAt: "2026-01-01T00:00:00.000Z",
    stars: 16_400,
    read: true,
    icon: null,
    ownerType: "org" as const,
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
  };
  return { ...repo, text: searchText(repo) };
};

const at = Date.parse("2026-11-05T00:00:00.000Z");

describe("the repo panel's detail", () => {
  test("a summary that says something new gets its own section", () => {
    expect(toDetail(entry("Widgets for charts.", "A TUI library with charts and tables."), at).summary).toBe(
      "A TUI library with charts and tables.",
    );
  });

  test("a summary that repeats the description, or no summary at all, shows nothing twice", () => {
    expect(toDetail(entry("Widgets for charts.", "Widgets for charts."), at).summary).toBeUndefined();
    expect(toDetail(entry("Widgets for charts.", null), at).summary).toBeUndefined();
  });
});
