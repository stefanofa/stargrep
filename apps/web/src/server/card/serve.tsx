/// <reference path="./wasm-imports.d.ts" />
import fredoka600 from "@fontsource/fredoka/files/fredoka-latin-600-normal.woff?inline";
import inter500 from "@fontsource/inter/files/inter-latin-500-normal.woff?inline";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff?inline";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import { isGitHubLogin } from "@stargrep/github/login";
import layoutWasm from "satori/yoga.wasm?module";
import { previewImage } from "../../lib/preview.ts";
import { type CardSource, readAccountCard } from "./account.ts";
import { AccountCard } from "./card.tsx";
import { cardRenderer } from "./render.ts";

// Vite inlines each font as a data URL, since the Worker can import WebAssembly but no other binary.
const bytesOf = (dataUrl: string) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const render = cardRenderer({
  layoutWasm,
  resvgWasm,
  fonts: {
    fredoka600: bytesOf(fredoka600).buffer,
    inter500: bytesOf(inter500).buffer,
    inter600: bytesOf(inter600).buffer,
  },
});

export interface CardRoute {
  readonly cache: Cache;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly source: CardSource;
  readonly report: (error: unknown) => void;
}

// A card whose address names the revision it drew is kept a day, since a new import or read star changes the page's
// address for it. Any other card describes whatever the library holds now, so it is kept 10 minutes.
const keep = { revision: "public, max-age=86400", current: "public, max-age=600" };

const loginOf = (pathname: string) => {
  const login = pathname.match(/^\/og\/([^/]+)\.png$/)?.[1];
  return login !== undefined && isGitHubLogin(login) ? login : undefined;
};

const answer = async (request: Request, url: URL, { cache, waitUntil, source, report }: CardRoute) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const login = loginOf(url.pathname);
  if (login === undefined) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const version = url.searchParams.get("v");
  const query = url.searchParams.get("q") ?? "";
  const key = new URL(url.pathname, url.origin);
  if (version !== null) key.searchParams.set("v", version);
  if (query !== "") key.searchParams.set("q", query);
  const cacheKey = new Request(key);
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;
  const started = performance.now();
  // A card that cannot be read, such as when the API refuses the caller, falls back to the site's card, uncached.
  const drawn = await readAccountCard(source, login, query)
    .then(async ({ card, revision }) => ({ png: await render(<AccountCard card={card} />), revision }))
    .catch((error: unknown) => {
      report(error);
      return undefined;
    });
  if (drawn === undefined) {
    return new Response(null, {
      status: 302,
      headers: { location: new URL(previewImage.path, url.origin).href, "cache-control": "no-store" },
    });
  }
  const response = new Response(drawn.png.slice(), {
    headers: {
      "content-type": "image/png",
      "cache-control": version === drawn.revision ? keep.revision : keep.current,
    },
  });
  waitUntil(cache.put(cacheKey, response.clone()));
  response.headers.set("server-timing", `card;dur=${Math.round(performance.now() - started)}`);
  return response;
};

export const serveCard = (request: Request, route: CardRoute) => answer(request, new URL(request.url), route);
