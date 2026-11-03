import "./register.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { type Filter, SearchTile } from "../src/index.ts";
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

  test("slash focuses the search input from anywhere on the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("/");
    expect(document.activeElement).toBe(page().getByRole("searchbox"));
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("");
  });
});
