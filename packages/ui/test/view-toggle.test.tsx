import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { type Result, Results, type View, ViewToggle } from "../src/index.ts";
import { page } from "./dom.ts";

const results: Result[] = [
  {
    owner: "ratatui",
    name: "ratatui",
    href: "?repo=ratatui/ratatui",
    reason: "Widgets for charts and gauges.",
    matches: [[12, 18]],
    activity: { state: "alive", label: "pushed 2 days ago" },
    stars: 16_400,
    starred: "Mar 14, 2025",
    network: [{ login: "kofi" }],
    visual: { kind: "monogram", letters: "ra" },
    language: "Rust",
    unread: false,
  },
  {
    owner: "fdehau",
    name: "tui-rs",
    href: "?repo=fdehau/tui-rs",
    reason: "Where ratatui came from.",
    matches: [],
    activity: { state: "archived" },
    stars: 11_100,
    starred: "Feb 21, 2025",
    network: [],
    visual: { kind: "monogram", letters: "fd" },
    language: "Rust",
    unread: false,
  },
];

function Search() {
  const [view, setView] = useState<View>("tiles");
  return (
    <>
      <ViewToggle value={view} onValueChange={setView} />
      <Results view={view} groups={[{ key: "all", results }]} />
    </>
  );
}

const pressed = (name: string) => page().getByRole("button", { name }).getAttribute("aria-pressed");

describe("view toggle", () => {
  test("defaults to tiles", () => {
    render(<Search />);
    expect(pressed("Tiles view")).toBe("true");
    expect(pressed("List view")).toBe("false");
  });

  test("switching views changes one wrapper class and leaves the result markup untouched", async () => {
    const user = userEvent.setup();
    render(<Search />);
    const list = page().getByRole("list", { name: "Results" });
    const wrapper = list.closest(".view-tiles");
    const before = list.outerHTML;
    expect(wrapper).not.toBeNull();

    await user.click(page().getByRole("button", { name: "List view" }));

    expect(list.outerHTML).toBe(before);
    expect(wrapper?.classList.contains("view-list")).toBe(true);
    expect(wrapper?.classList.contains("view-tiles")).toBe(false);
  });

  test("without a value the toggle keeps its own state and reports changes", async () => {
    const user = userEvent.setup();
    const picked: View[] = [];
    render(<ViewToggle defaultValue="list" onValueChange={(view) => picked.push(view)} />);
    expect(pressed("List view")).toBe("true");
    await user.click(page().getByRole("button", { name: "Tiles view" }));
    expect(pressed("Tiles view")).toBe("true");
    expect(picked).toEqual(["tiles"]);
  });
});
