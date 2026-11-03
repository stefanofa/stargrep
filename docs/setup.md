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

## Local stage

`alchemy dev` runs the whole stage on your machine with no cloud account. It runs the Worker in workerd and simulates the queue, KV, R2, the Durable Object, the cron, and Hyperdrive. Only Neon has no local mode, so the local stage points Hyperdrive at a Postgres container.

1. Start Postgres 17 with pgvector. It listens on `127.0.0.1:54317` and creates the `vector` extension on first start.

   ```sh
   docker compose --file apps/worker/compose.yaml up --detach --wait
   ```

2. Run the stage. Alchemy prints the Worker URL, `http://localhost:1337` unless the port is taken, and keeps local state in `infra/.alchemy/`.

   ```sh
   bun run --cwd infra dev
   ```

3. Call the Worker.

   ```sh
   curl http://localhost:1337/health
   curl -X POST "http://localhost:1337/debug/queue?count=10"
   curl -X POST http://localhost:1337/debug/counter/demo
   curl "http://localhost:1337/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
   ```

   `/health` returns the Postgres and pgvector versions. The `/debug/` routes answer on every stage except `prod`.

4. Run the Worker tests. They run on workerd and need the Postgres container from step 1.

   ```sh
   bun run --cwd apps/worker test
   ```

## Cloudflare and Neon

The `deploy` workflow deploys stage `pr-<number>` for each pull request, destroys it when the pull request closes, and deploys stage `prod` on each push to `main`. Its jobs skip until the steps below are done.

1. Create a Cloudflare API token for the account with these permissions: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, Queues Write, Hyperdrive Write, Secrets Store Write, Account Settings Write, and Workers Tail Read. The Secrets Store permission is for Alchemy's state store, which keeps its keys there.

2. Create a Neon API key in the Neon console.

3. Add the token and key as GitHub Actions secrets, and the Cloudflare account ID as a variable. The variable turns the deploy jobs on.

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set NEON_API_KEY
   gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
   ```

4. Create Alchemy's state store in the account once. In CI, Alchemy refuses to create it, so a missing store fails the deploy.

   ```sh
   cd infra
   CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> bunx alchemy state bootstrap
   ```

The first deploy creates the Neon project `stargrep` through `infra/database.run.ts`. Every stage then gets its own branch of it. Neon deletes a preview branch about two weeks after its last deploy, in case its destroy job never ran.
