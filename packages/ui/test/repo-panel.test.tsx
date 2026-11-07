import "./register.ts";
import { expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { type RepoDetail, RepoPanel, type RepoVisual } from "../src/index.ts";
import { page } from "./dom.ts";

const repo: RepoDetail = {
  owner: "ratatui",
  name: "ratatui",
  description: "Build terminal user interfaces in Rust.",
  summary: "Widgets for charts.",
  stars: 16_400,
  activity: { state: "alive", label: "pushed 2 days ago" },
  network: [],
  alsoStarred: [],
  githubUrl: "https://github.com/ratatui/ratatui",
  visual: { kind: "monogram", letters: "ra" },
};

test("Open on GitHub opens the repo in a new tab without handing it the opener", () => {
  render(<RepoPanel repo={repo} open onOpenChange={() => {}} />);
  const link = page().getByRole("link", { name: "Open on GitHub" });
  expect(link.getAttribute("href")).toBe(repo.githubUrl);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

const slotIn = (visual: RepoVisual) => {
  render(<RepoPanel repo={{ ...repo, visual }} open onOpenChange={() => {}} />);
  const header = page().getByRole("heading", { name: "ratatui" }).closest("div")?.parentElement;
  const slot = header?.querySelector("[data-slot=repo-icon]");
  if (!slot) throw new Error("no repo icon in the panel header");
  return slot;
};

test("the panel header shows the repo's own icon left of its name", () => {
  const url = "https://icons.example/ratatui.webp";
  const slot = slotIn({ kind: "icon", url, plate: "light", size: 128, letters: "ra" });
  expect(slot.querySelector("img")?.getAttribute("src")).toBe(url);
  expect(slot.compareDocumentPosition(page().getByRole("heading", { name: "ratatui" }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("the panel header falls back to the owner's avatar, then the monogram", () => {
  const url = "https://avatars.githubusercontent.com/u/1?s=88";
  expect(slotIn({ kind: "avatar", url, letters: "ra" }).querySelector("img")?.getAttribute("src")).toBe(url);
  cleanup();
  expect(slotIn({ kind: "monogram", letters: "ra" }).textContent).toBe("ra");
});

test("the panel says who starred the repo", () => {
  render(
    <RepoPanel repo={{ ...repo, starred: { by: "@stefanofa", on: "Feb 6, 2026" } }} open onOpenChange={() => {}} />,
  );
  expect(page().getByText("@stefanofa starred it Feb 6, 2026")).toBeTruthy();
  expect(page().queryByText(/you starred it/)).toBeNull();
});
