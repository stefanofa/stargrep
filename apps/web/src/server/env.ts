import type { WebsiteEnv } from "../../website.ts";

export interface WebEnv {
  readonly DATABASE: Hyperdrive;
  readonly SEARCH_CACHE: KVNamespace;
  readonly SYNC_REQUESTS: KVNamespace;
  readonly SYNC_STARS: Queue<unknown>;
  readonly SYNC_PER_CALLER: RateLimit;
  readonly SYNC_OVERALL: RateLimit;
  readonly AI_GATEWAY_API_KEY?: string;
}

// Fails to compile when website.ts stops binding something the server reads.
type BindsWhatTheServerReads<Env extends WebEnv> = Env;

export type DeclaredEnv = BindsWhatTheServerReads<WebsiteEnv>;
