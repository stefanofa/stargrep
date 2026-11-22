import { iconsPath } from "@stargrep/api/icon-host";
import { isLogoKey, logoPrefix } from "@stargrep/api/topic-icons";
import { IconStore, Keys } from "@stargrep/core/icons";

const missingTtl = "public, max-age=300";

const notFound = (cacheControl: string) =>
  new Response(null, { status: 404, headers: { "cache-control": cacheControl } });

// Workers add caches.default to the standard CacheStorage.
export const workerCache = () => (caches as CacheStorage & { readonly default: Cache }).default;

interface IconRoute {
  readonly bucket: R2Bucket;
  readonly cache: Cache;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

// A topic's logo is baked into the Worker, and its name carries a hash of its bytes. The logos load with the first one.
const logo = async (key: string) => {
  const { logoSvgs } = await import("@stargrep/api/logo-svgs");
  const svg = logoSvgs[key.slice(logoPrefix.length)];
  return svg === undefined
    ? notFound(missingTtl)
    : new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": IconStore.cacheControl } });
};

const answer = async (request: Request, url: URL, { bucket, cache, waitUntil }: IconRoute) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const key = url.pathname.slice(iconsPath.length);
  if (isLogoKey(key)) return logo(key);
  // Only keys the icon writer makes are reachable, so nothing else in the bucket can be read and nothing is listed.
  if (!Keys.isIconKey(key)) return notFound("no-store");
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;
  const object = await bucket.get(key);
  let response = notFound(missingTtl);
  if (object !== null) {
    // The icon store writes the content type and immutable caching onto every object.
    const headers = new Headers({ etag: object.httpEtag });
    object.writeHttpMetadata(headers);
    response = new Response(object.body, { headers });
  }
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

export const serveIcon = (request: Request, route: IconRoute) => {
  const url = new URL(request.url);
  return url.pathname.startsWith(iconsPath) ? answer(request, url, route) : undefined;
};
