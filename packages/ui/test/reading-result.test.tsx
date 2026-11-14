import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { type Result, ResultItem } from "../src/index.ts";

const arrived: Result = {
  owner: "NVIDIA",
  name: "auto-ontology",
  href: "?repo=NVIDIA/auto-ontology",
  reason: "",
  matches: [],
  activity: { state: "reading" },
  stars: null,
  starred: "Nov 5, 2026",
  network: [],
  visual: { kind: "avatar", url: "https://github.com/NVIDIA.png", letters: "nv" },
  language: null,
  unread: true,
};

describe("a repo whose facts have not arrived", () => {
  test("reads as reading, with skeleton text instead of an empty description", () => {
    const { container } = render(<ResultItem result={arrived} />);
    expect(container.textContent).toContain("reading…");
    expect(container.textContent).not.toContain("no pushes yet");
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(2);
  });

  test("shows no star count and no not read yet chip", () => {
    const { container } = render(<ResultItem result={arrived} />);
    expect([...container.querySelectorAll("dt")].map((term) => term.textContent)).not.toContain("stars");
    expect(container.textContent).not.toContain("not read yet");
  });
});
