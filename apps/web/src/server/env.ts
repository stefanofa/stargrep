import type { WebsiteEnv } from "../../website.ts";
import type { OwnerWorker } from "./owner-lookup.ts";

export interface WebEnv {
  readonly DATABASE: Hyperdrive;
  readonly SEARCH_CACHE: KVNamespace;
  readonly SYNC_STARS: Queue<unknown>;
  readonly SYNC_PER_CALLER: RateLimit;
  readonly SYNC_OVERALL: RateLimit;
  readonly SEARCH_PER_CALLER: RateLimit;
  readonly STARS_PER_CALLER: RateLimit;
  readonly PLANNER_PER_CALLER: RateLimit;
  readonly PLANNER_OVERALL: RateLimit;
  readonly WORKER: Fetcher & OwnerWorker;
  readonly ICONS: R2Bucket;
  readonly CALLER_KEY: string;
  readonly AI_GATEWAY_API_KEY?: string;
}

type BindsWhatTheServerReads<Env extends WebEnv> = Env;

export type DeclaredEnv = BindsWhatTheServerReads<WebsiteEnv>;
