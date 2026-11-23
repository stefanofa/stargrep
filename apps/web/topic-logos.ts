import { iconsPath, logoPrefix } from "@stargrep/api/icon-host";
import { logoSvgs } from "@stargrep/api/logo-svgs";
import type { Plugin } from "vite";

const logosPath = `${iconsPath}${logoPrefix}`;

// Topic logos ship as static assets at the URLs topicIcon names, so Cloudflare answers them from the visitor's edge
// instead of the Worker placed in IAD. public/_headers makes them immutable, since each name carries a hash of its bytes.
export const topicLogos = (): Plugin => ({
  name: "stargrep:topic-logos",
  configureServer(server) {
    server.middlewares.use(logosPath, (request, response, next) => {
      const svg = logoSvgs[request.url?.slice(1) ?? ""];
      if (svg === undefined) return next();
      response.setHeader("content-type", "image/svg+xml");
      response.end(svg);
    });
  },
  generateBundle() {
    if (this.environment.name !== "client") return;
    for (const [key, svg] of Object.entries(logoSvgs)) {
      this.emitFile({ type: "asset", fileName: `${logosPath.slice(1)}${key}`, source: svg });
    }
  },
});
