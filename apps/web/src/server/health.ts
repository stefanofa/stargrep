// The main Worker answers /health with the database's state. In prod the zone route sends every path to this Worker,
// so it passes /health on unchanged. The path decides, never a route pattern, because Cloudflare matches route patterns
// against the query string too and would miss /health?x=1.
export const withHealth =
  (env: { readonly WORKER: Fetcher }, next: (request: Request) => Response | Promise<Response>) => (request: Request) =>
    new URL(request.url).pathname === "/health" ? env.WORKER.fetch(request) : next(request);
