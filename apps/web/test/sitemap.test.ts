import { expect, test } from "bun:test";
import type { Client } from "../src/lib/rpc.ts";
import { robots, sitemap } from "../src/server/sitemap.ts";

const listed = [
  { topic: "react", repos: 6900, ranked: 6815 },
  { topic: "nextjs", repos: 8145, ranked: 1057 },
  { topic: "c++", repos: 300, ranked: 120 },
  { topic: "effect", repos: 169, ranked: 50 },
];

const client = {
  listTopics: async ({ offset = 0, limit = 60 }: { offset?: number; limit?: number }) => {
    const topics = listed.slice(offset, offset + Math.min(limit, 2));
    const next = offset + topics.length;
    return { topics, total: listed.length, nextOffset: next < listed.length ? next : null };
  },
} as unknown as Client;

test("lists the site's pages and the topics with 100 or more ranked repos, across pages of the topic list", async () => {
  const xml = await sitemap(client, "https://stargrep.com");
  expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual([
    "https://stargrep.com/",
    "https://stargrep.com/people",
    "https://stargrep.com/topics",
    "https://stargrep.com/developers",
    "https://stargrep.com/topics/react",
    "https://stargrep.com/topics/nextjs",
    "https://stargrep.com/topics/c%2B%2B",
  ]);
});

test("points search engines at the sitemap on prod and keeps them off every other host", () => {
  expect(robots("https://stargrep.com/robots.txt")).toContain("Sitemap: https://stargrep.com/sitemap.xml");
  expect(robots("https://pr-175.preview.stargrep.com/robots.txt")).toBe("User-agent: *\nDisallow: /\n");
});
