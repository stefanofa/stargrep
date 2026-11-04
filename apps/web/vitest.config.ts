import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["SEARCH_CACHE", "SYNC_REQUESTS"],
        queueProducers: { SYNC_STARS: "sync-stars" },
        ratelimits: {
          SYNC_PER_CALLER: { namespace_id: "1", simple: { limit: 5, period: 60 } },
          SYNC_OVERALL: { namespace_id: "2", simple: { limit: 60, period: 60 } },
        },
      },
    }),
  ],
  test: { include: ["test/**/*.workerd-test.ts"], testTimeout: 30_000 },
});
