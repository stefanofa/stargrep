import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SearchTile, StatusLine } from "../src/index.ts";
import { page } from "./dom.ts";

function Harness({ query: initial = "" }: { query?: string }) {
  const [query, setQuery] = useState(initial);
  return <SearchTile query={query} onQueryChange={setQuery} />;
}

describe("search input", () => {
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
  test("is one live region that stays in the page while empty, so the next answer is announced", () => {
    const { rerender } = render(<StatusLine />);
    const region = page().getByRole("status");
    expect(region.textContent).toBe("");
    rerender(<StatusLine label="found 2 · meaning search didn't answer" phoneLabel="found 2 · meaning failed" />);
    expect(page().getByRole("status")).toBe(region);
    expect([...region.children].map((label) => [label.className, label.textContent])).toEqual([
      ["sm:hidden", "found 2 · meaning failed"],
      ["max-sm:hidden", "found 2 · meaning search didn't answer"],
    ]);
  });
});

describe("a server-rendered tile", () => {
  test("keeps what was typed before its script arrived", async () => {
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { act } = await import("@testing-library/react");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SearchTile query="terminal dashboard" />);
    document.body.append(container);
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "terminal recorder";
    const seen: Array<string> = [];
    await act(async () => {
      hydrateRoot(container, <SearchTile query="terminal dashboard" onQueryChange={(next) => seen.push(next)} />);
    });
    expect(seen).toEqual(["terminal recorder"]);
    container.remove();
  });
});

describe("the search box", () => {
  test("a clear button empties the box and keeps it focused, and shows only when there is text", async () => {
    const user = userEvent.setup();
    render(<Harness query="rust tui" />);
    await user.click(page().getByRole("button", { name: "Clear search" }));
    const box = page().getByRole<HTMLInputElement>("searchbox");
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    expect(page().queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  test("the search key on a touch keyboard puts the keyboard away", async () => {
    const user = userEvent.setup();
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...matchMedia(query),
      matches: query === "(pointer: coarse)",
    })) as typeof window.matchMedia;
    try {
      render(<Harness query="rust" />);
      await user.click(page().getByRole("searchbox"));
      await user.keyboard("{Enter}");
      expect(document.activeElement).not.toBe(page().getByRole("searchbox"));
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
