import "./register.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { type Filter, SearchTile, StatusLine } from "../src/index.ts";
import { page } from "./dom.ts";

const initial: Filter[] = [
  { id: "lang", label: "Rust" },
  { id: "starred", label: "Starred in 2025" },
  { id: "topic", label: "Topic: TUI" },
];

function Harness({ query: initialQuery = "" }: { query?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState(initial);
  return (
    <SearchTile
      query={query}
      onQueryChange={setQuery}
      filters={filters}
      onRemoveFilter={(removed) => setFilters((current) => current.filter((filter) => filter.id !== removed.id))}
    />
  );
}

const chips = () =>
  page()
    .queryAllByRole("listitem")
    .map((chip) => chip.textContent);

describe("filter chips", () => {
  test("backspace in an empty input removes the last chip, one per press", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(page().getByRole("searchbox"));
    await user.keyboard("{Backspace}");
    expect(chips()).toEqual(["Rust", "Starred in 2025"]);
    await user.keyboard("{Backspace}");
    expect(chips()).toEqual(["Rust"]);
  });

  test("backspace with text in the input deletes text and keeps every chip", async () => {
    const user = userEvent.setup();
    render(<Harness query="rust" />);
    await user.click(page().getByRole("searchbox"));
    await user.keyboard("{Backspace}");
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("rus");
    expect(chips()).toEqual(["Rust", "Starred in 2025", "Topic: TUI"]);
  });

  test("the x button removes its own chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(page().getByRole("button", { name: "Remove Starred in 2025" }));
    expect(chips()).toEqual(["Rust", "Topic: TUI"]);
  });

  test("without a query prop the tile keeps its own text and still removes chips", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    const removed: string[] = [];
    render(
      <SearchTile
        defaultQuery="ru"
        onQueryChange={(query) => typed.push(query)}
        filters={initial}
        onRemoveFilter={(filter) => removed.push(filter.id)}
      />,
    );
    await user.click(page().getByRole("searchbox"));
    await user.keyboard("{Backspace}{Backspace}{Backspace}");
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("");
    expect(typed).toEqual(["r", ""]);
    expect(removed).toEqual(["topic"]);
  });

  test("slash focuses the search input from anywhere on the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("/");
    expect(document.activeElement).toBe(page().getByRole("searchbox"));
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("");
  });
});

describe("status line", () => {
  const label = () => page().getByRole("status").firstElementChild;

  test("a new sync state settles its label in, once", () => {
    const { rerender } = render(<StatusLine icon="busy" label="loading your stars" />);
    expect(label()?.className).not.toContain("animate-settle");
    rerender(<StatusLine icon="synced" label="24 stars" />);
    expect(label()?.className).toContain("animate-settle");
  });

  test("search answers swap in place while you type", () => {
    const { rerender } = render(<StatusLine icon="synced" label="24 stars" />);
    rerender(<StatusLine icon="busy" label="searching" instant />);
    rerender(<StatusLine icon="found" label="found 3" instant />);
    expect(label()?.textContent).toBe("found 3");
    expect(label()?.className).not.toContain("animate-settle");
  });
});
