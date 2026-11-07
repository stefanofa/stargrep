export const rateLimitPolicy = {
  SYNC_PER_CALLER: { namespace: "sync-per-caller", simple: { limit: 5, period: 60 } },
  SYNC_OVERALL: { namespace: "sync-overall", simple: { limit: 60, period: 60 } },
  SEARCH_PER_CALLER: { namespace: "search-per-caller", simple: { limit: 120, period: 60 } },
  STARS_PER_CALLER: { namespace: "stars-per-caller", simple: { limit: 60, period: 60 } },
} satisfies Record<string, { namespace: string; simple: { limit: number; period: 60 } }>;
