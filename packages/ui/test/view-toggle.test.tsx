import "./register.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Result, Results, useStoredView, ViewToggle } from "../src/index.ts";
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
  },
];

function Search() {
  const [view, setView] = useStoredView();
  return (
    <>
      <ViewToggle value={view} onValueChange={setView} />
      <Results view={view} results={results} />
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

  test("the chosen view survives a remount through local storage", async () => {
    const user = userEvent.setup();
    const first = render(<Search />);
    await user.click(page().getByRole("button", { name: "List view" }));
    expect(pressed("List view")).toBe("true");
    first.unmount();

    render(<Search />);
    expect(pressed("List view")).toBe("true");
    expect(pressed("Tiles view")).toBe("false");
  });

  test("switching views changes one wrapper class and leaves the result markup untouched", async () => {
    const user = userEvent.setup();
    render(<Search />);
    const list = page().getByRole("list", { name: "Results" });
    const before = list.outerHTML;
    expect(list.parentElement?.classList.contains("view-tiles")).toBe(true);

    await user.click(page().getByRole("button", { name: "List view" }));

    expect(list.outerHTML).toBe(before);
    expect(list.parentElement?.classList.contains("view-list")).toBe(true);
    expect(list.parentElement?.classList.contains("view-tiles")).toBe(false);
  });

  test("an unreadable stored value falls back to tiles", () => {
    localStorage.setItem("stargrep:view", "carousel");
    render(<Search />);
    expect(pressed("Tiles view")).toBe("true");
  });
});
