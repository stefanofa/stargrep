import "./register.ts";
import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { type RepoDetail, RepoPanel } from "../src/index.ts";
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
};

test("Open on GitHub opens the repo in a new tab without handing it the opener", () => {
  render(<RepoPanel repo={repo} open onOpenChange={() => {}} />);
  const link = page().getByRole("link", { name: "Open on GitHub" });
  expect(link.getAttribute("href")).toBe(repo.githubUrl);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});
