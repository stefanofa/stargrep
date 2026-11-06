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

// `any` says the icon scales, which only an SVG does, so on a raster it says nothing about the size.
const largestSize = (sizes: string) =>
  Math.max(0, ...sizes.split(/\s+/).map((size) => Number(size.toLowerCase().split("x")[0]) || 0));

// The UI draws an icon under 64 px small on a plain tile, so a raster that small ranks below an SVG.
const fullTileSide = 64;
// Apple's default apple-touch-icon is 180 px, so one without `sizes` ranks as large, after those that declare a size.
const appleTouchSide = 180;

const ranks = ["apple-touch", "large-raster", "svg", "small-raster"] as const;

interface Link {
  readonly url: string;
  readonly rank: number;
  readonly size: number;
  readonly order: number;
}

const rankOf = (svg: boolean, appleTouch: boolean, size: number): (typeof ranks)[number] => {
  if (svg) return "svg";
  if (size < fullTileSide) return "small-raster";
  return appleTouch ? "apple-touch" : "large-raster";
};

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
    const size = largestSize(tag.get("sizes") ?? "");
    const rank = rankOf(svg, appleTouch, size || (appleTouch ? appleTouchSide : 0));
    return [{ url: url.href, rank: ranks.indexOf(rank), size, order }];
  });
  const ranked = links
    .toSorted((a, b) => a.rank - b.rank || b.size - a.size || a.order - b.order)
    .map((link) => link.url);
  return [...new Set([...ranked, new URL("/favicon.ico", page).href])].slice(0, maxIcons);
};
