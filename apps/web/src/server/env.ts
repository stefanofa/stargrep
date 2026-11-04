import type { WebsiteEnv } from "../../website.ts";

export interface WebEnv {
  readonly DATABASE: Hyperdrive;
  readonly SEARCH_CACHE: KVNamespace;
  readonly SYNC_STARS: Queue<unknown>;
  readonly SYNC_PER_CALLER: RateLimit;
  readonly SYNC_OVERALL: RateLimit;
  readonly WORKER: Fetcher;
  readonly AI_GATEWAY_API_KEY?: string;
}

type BindsWhatTheServerReads<Env extends WebEnv> = Env;

export type DeclaredEnv = BindsWhatTheServerReads<WebsiteEnv>;
