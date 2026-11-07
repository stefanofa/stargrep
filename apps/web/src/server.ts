import start from "@tanstack/react-start/server-entry";
import { bindings, serveApi, serveAuth } from "./server/app.ts";
import { withHealth } from "./server/health.ts";
import { serveIcon, workerCache } from "./server/icons.ts";

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
        start.fetch(incoming),
    )(request),
};
