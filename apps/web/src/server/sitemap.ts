import type { Client } from "../lib/rpc.ts";
import { indexable } from "./robots.ts";

// A topic gets a place in the sitemap once this many of its repos rank, so search engines see the topics worth landing on.
export const sitemapRanked = 100;

const pages = ["/", "/people", "/topics", "/developers"];

const xmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The site's pages and every topic page with enough ranked repos, most ranked first.
export const sitemap = async (client: Client, origin: string) => {
  const topics: Array<string> = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const page = await client.listTopics({ limit: 200, offset });
    const kept = page.topics.filter((topic) => topic.ranked >= sitemapRanked);
    topics.push(...kept.map((topic) => topic.topic));
    offset = kept.length < page.topics.length ? null : page.nextOffset;
  }
  const urls = [...pages, ...topics.map((topic) => `/topics/${encodeURIComponent(topic)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${xmlText(`${origin}${path}`)}</loc></url>`).join("\n")}
</urlset>
`;
};

// Search engines may read only prod's own host, and find its sitemap here.
export const robots = (url: string) =>
  indexable(url)
    ? `User-agent: *\nAllow: /\nSitemap: ${new URL("/sitemap.xml", url).href}\n`
    : "User-agent: *\nDisallow: /\n";
