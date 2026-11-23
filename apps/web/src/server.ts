import start from "@tanstack/react-start/server-entry";
import { cardPath } from "./lib/preview.ts";
import { bindings, reportFailure, serveApi, serveAuth } from "./server/app.ts";
import { compressJson } from "./server/compress.ts";
import { withHealth } from "./server/health.ts";
import { serveIcon, workerCache } from "./server/icons.ts";
import { inProcessFor } from "./server/in-process.ts";
import { withRobots } from "./server/robots.ts";
import { robots, sitemap } from "./server/sitemap.ts";

// A page's first byte waits on its loaders, so each page answers with its time to the response, as the API does.
const renderPage = async (request: Request) => {
  const started = performance.now();
  const response = await start.fetch(request);
  const timed = new Response(response.body, response);
  timed.headers.set("server-timing", `total;dur=${Math.round(performance.now() - started)}`);
  return withRobots(request, timed);
};

// The card renderer is 3.4 MB of JavaScript and WebAssembly, so it loads with the first card an isolate draws.
const serveCard = (request: Request, context: ExecutionContext) =>
  new URL(request.url).pathname.startsWith(cardPath)
    ? Promise.all([import("./server/card/serve.tsx"), import("./server/card/source.ts")]).then(
        ([{ serveCard }, { cardSource }]) =>
          serveCard(request, {
            cache: workerCache(),
            waitUntil: (promise) => context.waitUntil(promise),
            source: cardSource(request),
            report: (error) => context.waitUntil(reportFailure("Link preview card failed", {}, error, request)),
          }),
      )
    : undefined;

// The sitemap reads the topic list, which changes once a night, so it keeps an hour in the Worker's cache.
const serveCrawlers = (request: Request, context: ExecutionContext) => {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt")
    return Promise.resolve(
      new Response(robots(request.url), {
        headers: { "content-type": "text/plain", "cache-control": "public, max-age=3600" },
      }),
    );
  if (url.pathname !== "/sitemap.xml") return undefined;
  const key = new Request(new URL("/sitemap.xml", url.origin));
  return workerCache()
    .match(key)
    .then(async (cached) => {
      if (cached !== undefined) return cached;
      const body = await sitemap(inProcessFor(request), url.origin);
      const response = new Response(body, {
        headers: { "content-type": "application/xml", "cache-control": "public, max-age=3600" },
      });
      context.waitUntil(workerCache().put(key, response.clone()));
      return response;
    });
};

const serve = (request: Request, context: ExecutionContext) =>
  withHealth(
    bindings,
    (incoming) =>
      serveIcon(incoming, {
        bucket: bindings.ICONS,
        cache: workerCache(),
        waitUntil: (promise) => context.waitUntil(promise),
      }) ??
      serveCard(incoming, context) ??
      serveCrawlers(incoming, context) ??
      serveAuth(incoming) ??
      serveApi(incoming) ??
      renderPage(incoming),
  )(request);

export default {
  fetch: (request: Request, _env: unknown, context: ExecutionContext) =>
    Promise.resolve(serve(request, context))
      .then((response) => compressJson(request, response))
      .catch(async (error: unknown) => {
        await reportFailure("Web request failed", {}, error, request);
        throw error;
      }),
};
