// Renders one request the way the Worker renders a page: the real route tree, the server loaders handed over with
// provideServerLoads, the in-process API client and TanStack's SSR handler, with fake services behind the API. A test
// runs this in its own process with SSR set, so the server's module state never leaks into the hydrating browser.
//   SSR=1 bun test/render-server.tsx /path [cookie]
import { mock } from "bun:test";

const [path = "/", cookie] = process.argv.slice(2);
const request = new Request(`http://localhost${path}`, cookie === undefined ? {} : { headers: { cookie } });

const { serveApi, requested } = await import("./page-api.ts");
// Bun loads a CSS import as an object, where Vite gives the root route a URL string.
mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
// The Worker's app module binds Cloudflare's env. The page path only needs its API handler.
mock.module("../src/server/app.ts", () => ({ serveApi }));
// TanStack Start hands the request to server code through its own context, which this script stands in for.
mock.module("@tanstack/react-start/server", () => ({ getRequest: () => request }));

const { provideServerLoads } = await import("../src/lib/load-page.ts");
const { loadPage, loadSession } = await import("../src/server/page-data.ts");
const { routeTree } = await import("../src/routeTree.gen.ts");
const { createRouter } = await import("@tanstack/react-router");
const { createRequestHandler, RouterServer, renderRouterToString } = await import("@tanstack/react-router/ssr/server");

provideServerLoads({ session: loadSession, page: loadPage });

const handler = createRequestHandler({ request, createRouter: () => createRouter({ routeTree, isServer: true }) });
const response = await handler(({ router, responseHeaders }) =>
  renderRouterToString({ router, responseHeaders, children: <RouterServer router={router} /> }),
);
process.stdout.write(
  JSON.stringify({
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
    requested,
  }),
);
process.stdout.write("\n");
