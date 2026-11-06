import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { authHyperdrives } from "./test/auth-databases.ts";
import { fakeGitHub } from "./test/fake-github.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["SEARCH_CACHE"],
        r2Buckets: ["ICONS"],
        hyperdrives: { DATABASE: "postgres://stargrep:stargrep@127.0.0.1:1/stargrep", ...authHyperdrives },
        queueProducers: { SYNC_STARS: "sync-stars" },
        ratelimits: {
          SYNC_PER_CALLER: { namespace_id: "1", simple: { limit: 5, period: 60 } },
          SYNC_OVERALL: { namespace_id: "2", simple: { limit: 60, period: 60 } },
          SEARCH_PER_CALLER: { namespace_id: "3", simple: { limit: 120, period: 60 } },
          PLANNER_PER_CALLER: { namespace_id: "4", simple: { limit: 20, period: 60 } },
          PLANNER_OVERALL: { namespace_id: "5", simple: { limit: 300, period: 60 } },
          PLANNER_ONE_CALL: { namespace_id: "6", simple: { limit: 1, period: 60 } },
        },
        serviceBindings: { WORKER: "main-worker" },
        workers: [
          {
            // Stands in for the main Worker and echoes what it receives, so a test sees exactly what was forwarded.
            name: "main-worker",
            modules: true,
            compatibilityDate: "2026-11-01",
            script: `export default {
              fetch: (request) => Response.json(
                { method: request.method, url: request.url, probe: request.headers.get("x-probe") },
                { headers: { "x-answered-by": "main" } },
              ),
            };`,
          },
        ],
        outboundService: fakeGitHub,
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd-test.ts"],
    testTimeout: 30_000,
    globalSetup: ["./test/auth-databases.ts"],
    // With the module cache on, the plugin sends the whole warm import graph to workerd in one WebSocket message, which
    // workerd refuses past 32 MiB (cloudflare/workers-sdk#16349).
    fsModuleCache: false,
  },
});
