import { describe, expect, test } from "bun:test";
import { highlights, keywordTerms, type Searchable, score, searchText } from "../src/lib/keyword.ts";

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

  test("drops stopwords, wildcards, and extra spaces from a phrase", () => {
    expect(keywordTerms("  The Rust library for  50%_tui ")).toEqual(["rust", "library", "50tui"]);
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

  test("builds lowercase search text from every searchable field", () => {
    expect(searchText({ ...repo("Ratatui", "ratatui", ["TUI"]), description: "Widgets", language: "Rust" })).toBe(
      "ratatui ratatui widgets rust tui",
    );
  });
});
