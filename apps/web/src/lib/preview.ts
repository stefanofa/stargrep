// The host a page is served from. A link preview needs absolute URLs, and only prod's own host names a canonical URL,
// so a preview stage never claims to be the page search engines should index.
export interface Site {
  readonly origin: string;
  readonly indexable: boolean;
}

export const siteTitle = "stargrep";
export const siteDescription = "Search your starred GitHub repos in plain words.";

export interface PreviewImage {
  readonly path: string;
  readonly alt: string;
}

export const previewImage = {
  path: "/og.png",
  alt: "stargrep: search anyone's starred GitHub repos in plain words",
} satisfies PreviewImage;

export const previewSize = { width: 1200, height: 630 } as const;

export const cardPath = "/og/";

// A login's own card. Its address names the library revision the page read, so an import or a newly read star gives
// the page a new image address, and a link preview that keeps images by address draws the card again.
export const accountImage = (login: string, revision: string | null, query: string | undefined): PreviewImage => {
  const params = new URLSearchParams();
  if (revision !== null) params.set("v", revision);
  if (query) params.set("q", query);
  const search = params.size > 0 ? `?${params}` : "";
  return { path: `${cardPath}${login}.png${search}`, alt: `@${login}'s starred GitHub repos on stargrep` };
};

// A topic's card, and the card of a search a shared link carries on it.
export const topicImage = (topic: string, query: string | undefined): PreviewImage => ({
  path: `${cardPath}topics/${topic}.png${query ? `?${new URLSearchParams({ q: query })}` : ""}`,
  alt: query
    ? `searching ${topic} repos on stargrep for "${query}"`
    : `the ${topic} repos developers star, on stargrep`,
});

interface Preview {
  readonly title: string;
  readonly description: string;
  // The page's path and query, for og:url. Pages without one, such as an error page, leave it out.
  readonly path?: string | undefined;
  readonly image?: PreviewImage | undefined;
}

// Slack, Discord and HN tools read Open Graph, and X reads its own card type and falls back to Open Graph for the rest.
// A child route's tags replace the root's by name and property, so each page restates all of them.
export const previewMeta = (site: Site | undefined, { title, description, path, image = previewImage }: Preview) => [
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
        { property: "og:image", content: `${site.origin}${image.path}` },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: String(previewSize.width) },
        { property: "og:image:height", content: String(previewSize.height) },
        { property: "og:image:alt", content: image.alt },
        { name: "twitter:image", content: `${site.origin}${image.path}` },
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
