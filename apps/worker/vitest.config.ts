import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        hyperdrives: {
          DATABASE: "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep",
          UNREACHABLE_DATABASE: "postgres://stargrep:stargrep@127.0.0.1:1/stargrep",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.workerd-test.ts"], testTimeout: 30_000 },
});
