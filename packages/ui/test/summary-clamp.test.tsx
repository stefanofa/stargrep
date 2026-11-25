import "./dom.ts";
import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { type RepoDetail, RepoPanel, type Result, Results, type View } from "../src/index.ts";
import { page } from "./dom.ts";

const summary =
  "Build terminal UIs in Rust from ready widgets: charts, gauges, sparklines, tables, and lists. It draws in immediate mode on crossterm, termion, or termwiz, keeps a buffer per frame and diffs it, so only changed cells reach the terminal. The maintained fork of tui-rs, with a book, examples and templates.";

const result: Result = {
  owner: "ratatui",
  name: "ratatui",
  href: "?repo=ratatui/ratatui",
  reason: summary,
  matches: [[15, 18]],
  activity: { state: "alive", label: "pushed 2 days ago" },
  stars: 16_400,
  starred: "Mar 14, 2025",
  network: [],
  visual: { kind: "monogram", letters: "ra" },
  language: "Rust",
  unread: false,
};

const detail: RepoDetail = {
  owner: "ratatui",
  name: "ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  summary,
  stars: 16_400,
  activity: { state: "alive", label: "pushed 2 days ago" },
  network: [],
  githubUrl: "https://github.com/ratatui/ratatui",
  visual: { kind: "monogram", letters: "ra" },
};

const reasonsOf = (view: View) => {
  const results = [result, { ...result, name: "tui-rs", href: "?repo=ratatui/tui-rs" }];
  const { container } = render(<Results view={view} groups={[{ key: "all", results }]} hero="card" />);
  const [hero, tile] = [...container.querySelectorAll("article")].map((article) =>
    article.querySelector("mark")?.closest("p"),
  );
  if (!hero || !tile) throw new Error("no reason paragraph");
  return { hero, tile };
};

const clamps = (element: Element) =>
  new Set(element.className.split(/\s+/).filter((name) => name.includes("line-clamp")));

test("a tile clamps its summary to four lines and a list row to two, with the whole text and marks still there", () => {
  const { tile } = reasonsOf("tiles");
  expect(clamps(tile)).toEqual(new Set(["line-clamp-4", "list:line-clamp-2"]));
  expect(tile.closest(".view-tiles")).not.toBeNull();
  expect(tile.textContent).toBe(summary);
  expect([...tile.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["UIs"]);

  const row = reasonsOf("list").tile;
  expect(row.closest(".view-list")).not.toBeNull();
  expect(clamps(row).has("list:line-clamp-2")).toBe(true);
  expect(row.textContent).toBe(summary);
});

test("the wide hero tile clamps its larger text to three lines from the small breakpoint, four on phones", () => {
  const { hero } = reasonsOf("tiles");
  expect(clamps(hero)).toEqual(new Set(["line-clamp-4", "tiles:sm:line-clamp-3", "list:line-clamp-2"]));
  expect(hero.textContent).toBe(summary);
});

test("the panel shows the whole summary, unclamped", () => {
  render(<RepoPanel repo={detail} open onOpenChange={() => {}} />);
  const section = page().getByRole("heading", { name: "in short" }).closest("section");
  const text = section?.querySelector("p");
  expect(text?.textContent).toBe(summary);
  let node: Element | null | undefined = text;
  while (node) {
    expect(clamps(node).size).toBe(0);
    node = node.parentElement;
  }
});
