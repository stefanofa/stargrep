const maxIcons = 4;
const linkTag = /<link\b[^>]*>/gi;
const attribute = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const attributes = (tag: string) =>
  new Map(
    [...tag.matchAll(attribute)].map((match) => [
      (match[1] ?? "").toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? "",
    ]),
  );

const largestSize = (sizes: string) =>
  Math.max(
    0,
    ...sizes
      .toLowerCase()
      .split(/\s+/)
      .map((size) => (size === "any" ? Number.MAX_SAFE_INTEGER : Number(size.split("x")[0]) || 0)),
  );

interface Link {
  readonly url: string;
  readonly kind: number;
  readonly size: number;
  readonly order: number;
}

export const iconUrls = (html: string, page: string): ReadonlyArray<string> => {
  const head = html.split(/<\/head>/i)[0] ?? html;
  const links = [...head.matchAll(linkTag)].flatMap((match, order): ReadonlyArray<Link> => {
    const tag = attributes(match[0]);
    const rel = (tag.get("rel") ?? "").toLowerCase().split(/\s+/);
    const appleTouch = rel.some((token) => token.startsWith("apple-touch-icon"));
    if (!rel.includes("icon") && !appleTouch) return [];
    const url = URL.parse(tag.get("href") ?? "", page);
    if (url === null || !/^https?:$/.test(url.protocol)) return [];
    const svg = (tag.get("type") ?? "").includes("svg") || url.pathname.toLowerCase().endsWith(".svg");
    return [{ url: url.href, kind: svg ? 0 : appleTouch ? 1 : 2, size: largestSize(tag.get("sizes") ?? ""), order }];
  });
  const ranked = links
    .toSorted((a, b) => a.kind - b.kind || b.size - a.size || a.order - b.order)
    .map((link) => link.url);
  return [...new Set([...ranked, new URL("/favicon.ico", page).href])].slice(0, maxIcons);
};
