import "./register.ts";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { type Result, Results } from "../src/index.ts";

const repo = (name: string): Result => ({
  owner: "someone",
  name,
  href: `?repo=someone/${name}`,
  reason: "A repo.",
  matches: [],
  activity: { state: "alive", label: "pushed 2 days ago" },
  stars: 1_000,
  starred: "Mar 14, 2025",
  network: [],
  visual: { kind: "monogram", letters: "so" },
  language: "Rust",
  unread: false,
});

const played = () => {
  const animate = spyOn(Element.prototype, "animate");
  return {
    names: () => animate.mock.contexts.map((item) => (item as Element).querySelector("h3")?.textContent),
    [Symbol.dispose]: () => animate.mockRestore(),
  };
};

const list = (names: ReadonlyArray<string>) => (
  <Results view="tiles" groups={[{ key: "all", results: names.map(repo) }]} />
);

afterEach(cleanup);

describe("result entrances", () => {
  test("each result plays its entrance once, when it first appears", () => {
    using entrances = played();
    const { rerender } = render(list(["uv", "bun"]));
    expect(entrances.names()).toEqual(["uv", "bun"]);
    rerender(list(["uv", "bun", "deno"]));
    expect(entrances.names()).toEqual(["uv", "bun", "deno"]);
  });

  test("results that only change places as the query changes play nothing", () => {
    using entrances = played();
    const { rerender } = render(list(["uv", "bun", "deno"]));
    rerender(list(["deno", "uv", "bun"]));
    rerender(list(["bun", "deno"]));
    expect(entrances.names()).toEqual(["uv", "bun", "deno"]);
  });

  test("with reduced motion a result appears without fading", () => {
    using entrances = played();
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    );
    try {
      render(list(["uv"]));
      expect(entrances.names()).toEqual([]);
    } finally {
      media.mockRestore();
    }
  });
});
