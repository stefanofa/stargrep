import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        // The pool adds this rule only for a Wrangler config. Alchemy's bundler uploads the same imports as CompiledWasm.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm?module"] }],
        hyperdrives: {
          DATABASE: "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep",
          UNREACHABLE_DATABASE: "postgres://stargrep:stargrep@127.0.0.1:1/stargrep",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd-test.ts"],
    testTimeout: 30_000,
    // With the module cache on, the plugin sends the whole warm import graph to workerd in one WebSocket message, which
    // workerd refuses past its size limit once a second test file loads the consumers (cloudflare/workers-sdk#16349).
    fsModuleCache: false,
  },
});
