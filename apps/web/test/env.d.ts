declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./entry.ts");
  }
  interface Env {
    readonly SEARCH_CACHE: KVNamespace;
    readonly SYNC_REQUESTS: KVNamespace;
    readonly SYNC_STARS: Queue<unknown>;
    readonly SYNC_PER_CALLER: RateLimit;
    readonly SYNC_OVERALL: RateLimit;
  }
}
