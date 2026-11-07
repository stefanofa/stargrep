import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { defineConfig } from "vitest/config";

const generated = new URL("./.alchemy/test-runtime/", import.meta.url).pathname;
const databaseName = `stargrep_worker_runtime_${process.pid}`;
const object = {
  kind: "durableObject",
  constructor: Effect.die("bundle metadata"),
  services: Context.empty(),
} as const;
const bundle = await Effect.runPromise(
  Effect.gen(function* () {
    const bundler = yield* WorkerBundle;
    return yield* bundler.build({
      id: "Worker",
      main: new URL("./src/worker.ts", import.meta.url).pathname,
      compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
      entry: { kind: "effect", exports: { GitHubGate: object, UserGitHubGate: object } },
      stack: { name: "Stargrep", stage: "test" },
      extraOptions: { output: { dir: generated } },
      rules: [{ type: "CompiledWasm", globs: ["**/*.wasm?module"] }],
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/runtime/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm", "**/*.wasm?module"] }],
        bindings: {
          RUNTIME_ENTRY: `${generated}${bundle.files[0].path}`,
          ALCHEMY_DEV: "true",
          STARGREP_GITHUB_TOKEN: "fixture-server-token",
          STARGREP_GITHUB_SERVER_TOKEN: "pat",
          GITHUB_BUDGET_SHARE: "0.5",
          SyncStars_queueName: "sync-stars",
          SyncStarsDeadLetters_queueName: "sync-stars-dead-letters",
          EnrichRepos_queueName: "enrich-repo",
          EnrichReposDeadLetters_queueName: "enrich-repo-dead-letters",
          FetchIcons_queueName: "fetch-icon",
          FetchIconsDeadLetters_queueName: "fetch-icon-dead-letters",
        },
        r2Buckets: ["Readmes", "Icons"],
        queueProducers: {
          SyncStars: "sync-stars",
          SyncStarsDeadLetters: "sync-stars-dead-letters",
          EnrichRepos: "enrich-repo",
          EnrichReposDeadLetters: "enrich-repo-dead-letters",
          FetchIcons: "fetch-icon",
          FetchIconsDeadLetters: "fetch-icon-dead-letters",
        },
        durableObjects: { GitHubGate: "GitHubGate", UserGitHubGate: "UserGitHubGate" },
        hyperdrives: { Database: `postgres://stargrep:stargrep@127.0.0.1:54317/${databaseName}` },
      },
    }),
  ],
  test: {
    globalSetup: ["./test/runtime/setup.ts"],
    provide: { databaseName },
    include: ["test/runtime/**/*.workerd-test.ts"],
    testTimeout: 30_000,
    fsModuleCache: false,
  },
});
