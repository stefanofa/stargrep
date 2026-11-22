// Renders one request the way the Worker renders a page: the real route tree, the server branch of the page loaders,
// the in-process API client and TanStack's SSR handler, with fake services behind the API. A test
// runs this in its own process with SSR set, so the server's module state never leaks into the hydrating browser. With
// STARGREP_API_FAILURE set, the API's config call fails with that message, so the session loader fails. With
// STARGREP_PAGE_FAILURE set, the page loader fails with that message after the session loaded. With
// STARGREP_CACHED_SEARCH set to JSON such as {"q":"phone automation","minutesAgo":6}, the API's answer cache holds the
// demo's planned answer for q, stored that long before the render. STARGREP_HEADER_STARS sets the header's GitHub star
// count, which is none without it. With STARGREP_HELD_STARS set, the API never answers the server's reads of a library.
//   SSR=1 bun test/render-server.tsx /path [cookie]
import { mock } from "bun:test";
import { disabled } from "@stargrep/api/answer-cache";
import * as Effect from "effect/Effect";

const [path = "/", cookie] = process.argv.slice(2);
const request = new Request(`http://localhost${path}`, cookie === undefined ? {} : { headers: { cookie } });

const { serveApi, requested, searched, cacheHolding } = await import("./page-api.ts");
// Bun loads a CSS import as an object, where Vite gives the root route a URL string.
mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
// The Worker's app module binds Cloudflare's env. The page path needs its API handler, and a cache that keeps nothing,
// since each render runs in its own process, unless the test filled it before the render.
const failure = process.env.STARGREP_API_FAILURE;
const starsHeld = process.env.STARGREP_HELD_STARS !== undefined;
const answer = (incoming: Request) => {
  const { pathname } = new URL(incoming.url);
  if (failure !== undefined && pathname === "/rpc/config") return Promise.reject(new Error(failure));
  if (starsHeld && pathname === "/rpc/stars") return new Promise<never>(() => {});
  return serveApi(incoming);
};
const filled = process.env.STARGREP_CACHED_SEARCH;
const { q, minutesAgo } = filled === undefined ? { q: undefined, minutesAgo: 0 } : JSON.parse(filled);
const answerCache = q === undefined ? disabled : await cacheHolding(q, minutesAgo);
const starsSet = process.env.STARGREP_HEADER_STARS;
const headerStars = starsSet === undefined || starsSet === "" ? null : Number(starsSet);
mock.module("../src/server/app.ts", () => ({
  serveApi: answer,
  answers: () => answerCache,
  waitUntil: () => {},
  headerStars: async () => headerStars,
  reportFailure: (message: string, fields: Readonly<Record<string, unknown>>) =>
    Effect.runPromise(Effect.logError(message, fields)),
}));
// TanStack Start hands the request to server code through its own context, which this script stands in for.
const pageFailure = process.env.STARGREP_PAGE_FAILURE;
let reads = 0;
const headers: Record<string, string> = {};
let status: number | undefined;
mock.module("@tanstack/react-start/server", () => ({
  getRequest: () => {
    reads += 1;
    if (pageFailure !== undefined && reads > 1) throw new Error(pageFailure);
    return request;
  },
  setResponseHeader: (name: string, value: string) => {
    headers[name] = value;
  },
  setResponseStatus: (code: number) => {
    status = code;
  },
}));

const { routeTree } = await import("../src/routeTree.gen.ts");
const { createRouter } = await import("@tanstack/react-router");
const { createRequestHandler, RouterServer, renderRouterToString } = await import("@tanstack/react-router/ssr/server");

const handler = createRequestHandler({ request, createRouter: () => createRouter({ routeTree, isServer: true }) });
const response = await handler(({ router, responseHeaders }) =>
  renderRouterToString({ router, responseHeaders, children: <RouterServer router={router} /> }),
);
process.stdout.write(
  JSON.stringify({
    status: status ?? response.status,
    location: response.headers.get("location"),
    html: await response.text(),
    requested,
    searched,
    headers,
    cacheControl: response.headers.get("cache-control"),
  }),
);
process.stdout.write("\n");
