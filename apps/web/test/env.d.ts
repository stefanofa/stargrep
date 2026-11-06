declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./entry.ts");
  }
  interface Env {
    readonly DATABASE: Hyperdrive;
    readonly SEARCH_CACHE: KVNamespace;
    readonly SYNC_STARS: Queue<unknown>;
    readonly SYNC_PER_CALLER: RateLimit;
    readonly SYNC_OVERALL: RateLimit;
    readonly SEARCH_PER_CALLER: RateLimit;
    readonly PLANNER_PER_CALLER: RateLimit;
    readonly PLANNER_OVERALL: RateLimit;
    readonly WORKER: Fetcher;
    readonly ICONS: R2Bucket;
  }
}
