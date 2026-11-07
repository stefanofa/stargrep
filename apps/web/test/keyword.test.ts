import { describe, expect, test } from "bun:test";
import { highlights, keywordTerms, matchesEvery, type Searchable, score, searchText } from "../src/lib/keyword.ts";

const repo = (owner: string, name: string, topics: ReadonlyArray<string> = []): Searchable => ({
  owner,
  name,
  description: null,
  summary: null,
  language: null,
  topics,
  keywords: [],
});

describe("keywordTerms", () => {
  test("keeps a lone stopword so a name typed letter by letter narrows on every key", () => {
    expect(keywordTerms("i")).toEqual(["i"]);
    expect(keywordTerms("in")).toEqual(["in"]);
  });

  test("drops stopwords and extra spaces from a phrase", () => {
    expect(keywordTerms("  The Rust library for  50%_tui ")).toEqual(["rust", "library", "50%_tui"]);
  });
});

describe("matchesEvery", () => {
  const entries = [
    { name: "bottom", text: "a system monitor dashboard for the terminal" },
    { name: "console", text: "terminal dashboard for async rust tasks" },
    { name: "ratatui", text: "widgets for terminal apps" },
    { name: "sweep", text: "deletes node_modules folders" },
    { name: "nodemodules", text: "nodemodules helper" },
  ];
  const names = (query: string) => matchesEvery(entries, keywordTerms(query)).map((entry) => entry.name);

  test("keeps the entries that contain every term, in any case", () => {
    expect(names("Terminal Dashboard")).toEqual(["bottom", "console"]);
  });

  test("reads a percent sign or an underscore as itself", () => {
    expect(names("node_modules")).toEqual(["sweep"]);
    expect(names("50%")).toEqual([]);
  });

  test("matches nothing for an empty query", () => {
    expect(names("  ")).toEqual([]);
  });
});

describe("score", () => {
  test("ranks an exact name first and a topic below any name match", () => {
    const ranked = [
      repo("drizzle-team", "drizzle-studio-expo", ["drizzle"]),
      repo("someone", "orm-tools", ["drizzle"]),
      repo("drizzle-team", "drizzle-orm"),
      repo("acme", "drizzle"),
    ].toSorted((a, b) => score(b, ["drizzle"]) - score(a, ["drizzle"]));
    expect(ranked.map((entry) => entry.name)).toEqual(["drizzle", "drizzle-studio-expo", "drizzle-orm", "orm-tools"]);
    expect(score(repo("drizzle-team", "drizzle-orm"), ["drizzle"])).toBe(
      score(repo("drizzle-team", "drizzle-studio-expo", ["drizzle"]), ["drizzle"]),
    );
  });

  test("puts an owner/name phrase ahead of everything else", () => {
    expect(score(repo("ratatui", "ratatui"), ["ratatui/ratatui"])).toBe(1000);
  });
});

describe("highlights", () => {
  test("marks every occurrence of every term, in any case", () => {
    expect(highlights("Terminal UI for the terminal", ["terminal", "ui"])).toEqual([
      [0, 8],
      [20, 28],
      [9, 11],
    ]);
  });

  test("marks a term only where it starts a word", () => {
    const text = "Lets control jailbreaking, pairing and remote-control";
    expect(highlights(text, ["let", "control", "ai"])).toEqual([
      [0, 3],
      [5, 12],
      [46, 53],
    ]);
  });

  test("marks a term of two letters only as a whole word", () => {
    expect(highlights("AI aims for ai, not email", ["ai"])).toEqual([
      [0, 2],
      [12, 14],
    ]);
  });

  test("marks a term that starts with punctuation wherever it appears", () => {
    expect(highlights("a dotnet .net port", [".net"])).toEqual([[9, 13]]);
  });

  test("builds lowercase search text from every searchable field", () => {
    expect(searchText({ ...repo("Ratatui", "ratatui", ["TUI"]), description: "Widgets", language: "Rust" })).toBe(
      "ratatui ratatui widgets rust tui",
    );
  });
});
