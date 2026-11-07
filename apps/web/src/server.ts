import start from "@tanstack/react-start/server-entry";
import { bindings, serveApi, serveAuth } from "./server/app.ts";
import { withHealth } from "./server/health.ts";
import { serveIcon, workerCache } from "./server/icons.ts";

// A page's first byte waits on its loaders, so each page answers with its time to the response, as the API does.
const renderPage = async (request: Request) => {
  const started = performance.now();
  const response = await start.fetch(request);
  const timed = new Response(response.body, response);
  timed.headers.set("server-timing", `total;dur=${Math.round(performance.now() - started)}`);
  return timed;
};

export default {
  fetch: (request: Request, _env: unknown, context: ExecutionContext) =>
    withHealth(
      bindings,
      (incoming) =>
        serveIcon(incoming, {
          bucket: bindings.ICONS,
          cache: workerCache(),
          waitUntil: (promise) => context.waitUntil(promise),
        }) ??
        serveAuth(incoming) ??
        serveApi(incoming) ??
        renderPage(incoming),
    )(request),
};
