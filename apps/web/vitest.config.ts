import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { rateLimitPolicy } from "./rate-limit-policy.ts";
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
        ratelimits: Object.fromEntries(
          Object.entries(rateLimitPolicy).map(([name, policy]) => [
            name,
            { namespace_id: policy.testNamespaceId, simple: policy.simple },
          ]),
        ),
        bindings: { CALLER_KEY: "test-caller-key", GITHUB_BUDGET_SHARE: "0.5" },
        serviceBindings: { WORKER: "main-worker" },
        workers: [
          {
            // Stands in for the main Worker. Its fetch echoes what it receives, so a test sees exactly what was forwarded,
            // and lookupOwner answers by login the way the real RPC method does.
            name: "main-worker",
            modules: true,
            compatibilityDate: "2026-11-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
            const idOf = (login) => [...login].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000000007, 7) + 1;
            const account = (login, type) => ({
              id: idOf(login), login, type, name: null, avatarUrl: null, followers: type === "user" ? 1 : null, publicRepos: 2,
            });
            export default class extends WorkerEntrypoint {
              fetch(request) {
                return Response.json(
                  { method: request.method, url: request.url, probe: request.headers.get("x-probe") },
                  { headers: { "x-answered-by": "main" } },
                );
              }
              lookupOwner(login) {
                switch (login.toLowerCase()) {
                  case "ghost-login": return { _tag: "Missing" };
                  case "budget-spent": return { _tag: "Unavailable", reason: "budget" };
                  case "github-down": return { _tag: "Unavailable", reason: "github" };
                  case "malformed": return { _tag: "Found", owner: { starredTotal: "many" } };
                  case "envelope": return { _tag: "~alchemy/rpc/error", error: { _tag: "Boom" } };
                  case "an-org": return { _tag: "Found", owner: { account: account(login, "org"), starredTotal: 0 } };
                  default: return { _tag: "Found", owner: { account: account(login, "user"), starredTotal: 42 } };
                }
              }
            }`,
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
