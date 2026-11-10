import { describe, expect, test } from "bun:test";
import { defaultParseSearch } from "@tanstack/react-router";
import { searchText } from "../src/lib/keyword.ts";
import type { LibraryEntry } from "../src/lib/library-collection.ts";
import { toDetail, toResult } from "../src/lib/present.ts";
import { validateParams } from "../src/lib/search-params.ts";

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
    atoms: [],
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
    expect(
      toDetail(entry("Widgets for charts.", "A TUI library with charts and tables."), at, { own: true }).summary,
    ).toBe("A TUI library with charts and tables.");
  });

  test("a summary that repeats the description, or no summary at all, shows nothing twice", () => {
    expect(toDetail(entry("Widgets for charts.", "Widgets for charts."), at, { own: true }).summary).toBeUndefined();
    expect(toDetail(entry("Widgets for charts.", null), at, { own: true }).summary).toBeUndefined();
  });
});

test("the panel says who starred the repo: the viewer on their own page, the owner on anyone else's", () => {
  const repo = entry("Widgets for charts.", null);
  expect(toDetail(repo, at, { own: true }).starred).toEqual({ by: "you", on: "Jan 1, 2026" });
  expect(toDetail(repo, at, { own: false, login: "stefanofa" }).starred).toEqual({
    by: "@stefanofa",
    on: "Jan 1, 2026",
  });
});

test("the panel shows the same repo visual as the card", () => {
  const repo = entry("Widgets for charts.", null);
  expect(toDetail(repo, at, { own: true }).visual).toEqual(toResult(repo, at).visual);
  expect(toDetail(repo, at, { own: true }).visual).toMatchObject({ kind: "avatar", letters: "ra" });
});

test("a result's link opens the repo over the same query, view and sort, and drops a sign-in error", () => {
  const search = {
    q: "123",
    view: "list",
    sort: "stars",
    lang: "Rust",
    repo: "other/repo",
    error: "access_denied",
  } as const;
  const { href } = toResult(entry("Widgets for charts.", null), at, { search });
  expect(validateParams(defaultParseSearch(href))).toEqual({
    q: "123",
    view: "list",
    sort: "stars",
    lang: "Rust",
    repo: "ratatui/ratatui",
  });
});
