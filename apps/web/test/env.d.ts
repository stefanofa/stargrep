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
    readonly STARS_PER_CALLER: RateLimit;
    readonly WORKER: Fetcher & { readonly lookupOwner: (login: string) => Promise<unknown> };
    readonly CALLER_KEY: string;
    readonly ICONS: R2Bucket;
  }
}
