export const rateLimitPolicy = {
  SYNC_PER_CALLER: { namespace: "sync-per-caller", testNamespaceId: "1", simple: { limit: 5, period: 60 } },
  SYNC_OVERALL: { namespace: "sync-overall", testNamespaceId: "2", simple: { limit: 60, period: 60 } },
  SEARCH_PER_CALLER: { namespace: "search-per-caller", testNamespaceId: "3", simple: { limit: 120, period: 60 } },
  STARS_PER_CALLER: { namespace: "stars-per-caller", testNamespaceId: "7", simple: { limit: 60, period: 60 } },
} satisfies Record<string, { namespace: string; testNamespaceId: string; simple: { limit: number; period: 60 } }>;
