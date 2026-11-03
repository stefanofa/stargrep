# Setup

These are the one-time steps to work on Stargrep. Each later step that needs an account, such as Cloudflare, Neon, or the GitHub App, is added here by the change that first needs it.

## Local checkout

1. Install Bun 1.4.3. The root `package.json` pins it in `packageManager`, and CI reads the version from there.

   ```sh
   curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
   ```

2. Install dependencies. The `postinstall` script runs `effect-tsgo patch`, which adds the Effect language service to the local TypeScript 7 install, so editors report Effect diagnostics.

   ```sh
   bun install --frozen-lockfile
   ```

3. Run lint and typecheck. Turborepo caches both, so a second run with no changes replays the logs.

   ```sh
   bun run check
   ```

4. Run the tests.

   ```sh
   bun test --parallel
   ```

   Use `--parallel`, not `--concurrent`. Under `--concurrent`, Bun gives the `packages/testing` helper no way to interrupt a test that times out, so its finalizers never run.

## Editor

VS Code and editors based on it pick up `.vscode/settings.json`. It turns on the native TypeScript 7 server from `node_modules/typescript` and sets Biome as the formatter. Accept the prompt to use the workspace TypeScript version, and install the Biome extension when the editor recommends it.

For other editors, run `bunx effect-tsgo setup --help` to see the setup for Neovim and Emacs.
