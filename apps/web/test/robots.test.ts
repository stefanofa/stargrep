import { expect, test } from "bun:test";
import { indexable, withRobots } from "../src/server/robots.ts";

test("only prod's own host is indexable", () => {
  expect(indexable("https://stargrep.com/?q=x")).toBe(true);
  expect(["https://pr-12.stargrep.com/", "https://www.stargrep.com/", "http://localhost:3000/"].map(indexable)).toEqual(
    [false, false, false],
  );
});

test("a preview page tells search engines not to index it, and prod's does not", () => {
  const page = (url: string) => withRobots(new Request(url), new Response("ok")).headers.get("x-robots-tag");
  expect(page("https://pr-12.stargrep.com/")).toBe("noindex, nofollow");
  expect(page("https://stargrep.com/")).toBeNull();
});
