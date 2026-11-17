// The host a page is served from. A link preview needs absolute URLs, and only prod's own host names a canonical URL,
// so a preview stage never claims to be the page search engines should index.
export interface Site {
  readonly origin: string;
  readonly indexable: boolean;
}

export const siteTitle = "stargrep";
export const siteDescription = "Search your starred GitHub repos in plain words.";

export const previewImage = {
  path: "/og.png",
  width: 1200,
  height: 630,
  alt: "stargrep: search anyone's starred GitHub repos in plain words",
} as const;

interface Preview {
  readonly title: string;
  readonly description: string;
  // The page's path and query, for og:url. Pages without one, such as an error page, leave it out.
  readonly path?: string | undefined;
}

// Slack, Discord and HN tools read Open Graph, and X reads its own card type and falls back to Open Graph for the rest.
// A child route's tags replace the root's by name and property, so each page restates all of them.
export const previewMeta = (site: Site | undefined, { title, description, path }: Preview) => [
  { title },
  { name: "description", content: description },
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: siteTitle },
  { property: "og:title", content: title },
  { property: "og:description", content: description },
  ...(site === undefined
    ? []
    : [
        ...(path === undefined ? [] : [{ property: "og:url", content: `${site.origin}${path}` }]),
        { property: "og:image", content: `${site.origin}${previewImage.path}` },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: String(previewImage.width) },
        { property: "og:image:height", content: String(previewImage.height) },
        { property: "og:image:alt", content: previewImage.alt },
        { name: "twitter:image", content: `${site.origin}${previewImage.path}` },
      ]),
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:title", content: title },
  { name: "twitter:description", content: description },
];

// A stars page is the same page whatever its sort, view or open repo, so its address keeps only the query.
export const pagePath = (pathname: string, query: string | undefined) =>
  query ? `${pathname}?${new URLSearchParams({ q: query })}` : pathname;

export const canonicalLinks = (site: Site | undefined, path: string) =>
  site?.indexable ? [{ rel: "canonical", href: `${site.origin}${path}` }] : [];
