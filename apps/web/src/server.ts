import start from "@tanstack/react-start/server-entry";
import { bindings, reportFailure, serveApi, serveAuth } from "./server/app.ts";
import { withHealth } from "./server/health.ts";
import { serveIcon, workerCache } from "./server/icons.ts";
import { withRobots } from "./server/robots.ts";

// A page's first byte waits on its loaders, so each page answers with its time to the response, as the API does.
const renderPage = async (request: Request) => {
  const started = performance.now();
  const response = await start.fetch(request);
  const timed = new Response(response.body, response);
  timed.headers.set("server-timing", `total;dur=${Math.round(performance.now() - started)}`);
  return withRobots(request, timed);
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
      serveAuth(incoming) ??
      serveApi(incoming) ??
      renderPage(incoming),
  )(request);

export default {
  fetch: (request: Request, _env: unknown, context: ExecutionContext) =>
    Promise.resolve(serve(request, context)).catch(async (error: unknown) => {
      await reportFailure("Web request failed", {}, error, request);
      throw error;
    }),
};
