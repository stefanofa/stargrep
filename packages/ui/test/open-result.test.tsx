import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Result, Results } from "../src/index.ts";
import { page } from "./dom.ts";

const result: Result = {
  owner: "ratatui",
  name: "ratatui",
  href: "?repo=ratatui/ratatui",
  reason: "Widgets for charts.",
  matches: [],
  activity: { state: "alive", label: "pushed 2 days ago" },
  stars: 16_400,
  starred: "Mar 14, 2025",
  network: [],
  visual: { kind: "monogram", letters: "ra" },
  language: "Rust",
  unread: false,
};

describe("opening a result", () => {
  test("a plain click hands the result and its link to onOpen instead of navigating", async () => {
    const user = userEvent.setup();
    const opened: Array<[string, HTMLElement]> = [];
    render(
      <Results
        view="tiles"
        groups={[{ key: "all", results: [result] }]}
        onOpen={(open, link) => opened.push([open.name, link])}
      />,
    );
    const link = page().getByRole("link", { name: "ratatui" });
    await user.click(link);
    expect(opened).toEqual([["ratatui", link]]);
    expect(location.search).toBe("");
  });

  test("a modified click is left to the browser", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(
      <Results view="tiles" groups={[{ key: "all", results: [result] }]} onOpen={(open) => opened.push(open.name)} />,
    );
    await user.keyboard("{Meta>}");
    await user.click(page().getByRole("link", { name: "ratatui" }));
    await user.keyboard("{/Meta}");
    expect(opened).toEqual([]);
  });
});
