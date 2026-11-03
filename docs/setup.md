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

4. Run the tests. The `packages/db` tests need Postgres 17 with pgvector, so start the container from "Local stage" first. Each test file creates its own database in it, migrates it, and drops it at the end.

   ```sh
   docker compose --file apps/worker/compose.yaml up --detach --wait
   bun test --parallel
   ```

   Use `--parallel`, not `--concurrent`. Under `--concurrent`, Bun gives the `packages/testing` helper no way to interrupt a test that times out, so its finalizers never run.

## Editor

VS Code and editors based on it pick up `.vscode/settings.json`. It turns on the native TypeScript 7 server from `node_modules/typescript` and sets Biome as the formatter. Accept the prompt to use the workspace TypeScript version, and install the Biome extension when the editor recommends it.

For other editors, run `bunx effect-tsgo setup --help` to see the setup for Neovim and Emacs.

## Local stage

`alchemy dev` runs the whole stage on your machine with no cloud account. It runs both Workers in workerd and simulates the queue, KV, R2, the Durable Objects, the cron, and Hyperdrive. Only Neon has no local mode, so the local stage points Hyperdrive at a Postgres container.

1. Start Postgres 17 with pgvector. It listens on `127.0.0.1:54317` and creates the `vector` extension on first start.

   ```sh
   docker compose --file apps/worker/compose.yaml up --detach --wait
   ```

2. Run the stage. Alchemy prints both URLs, the Worker on `http://localhost:1337` and the debug Worker on `http://localhost:1338` unless the ports are taken, and keeps local state in `infra/.alchemy/`.

   ```sh
   bun run --cwd infra dev
   ```

3. Call the Worker. `/health` returns the Postgres and pgvector versions.

   ```sh
   curl http://localhost:1337/health
   ```

4. Call the debug Worker. Its routes need the stage's token, which the stack generates and keeps in its outputs.

   ```sh
   TOKEN=$(bun scripts/stage-output.ts "dev_$USER" debugToken --backend local)
   curl -X POST -H "authorization: Bearer $TOKEN" "http://localhost:1338/queue?count=10"
   curl -X POST -H "authorization: Bearer $TOKEN" http://localhost:1338/counter/demo
   curl -X POST -H "authorization: Bearer $TOKEN" http://localhost:1338/transaction
   curl -H "authorization: Bearer $TOKEN" http://localhost:1338/budget
   curl "http://localhost:1338/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
   bun scripts/stage-smoke.ts "dev_$USER" --backend local
   ```

   The routes spend from a budget of 300 units a minute: one per counter read, counter increment, or transaction, and one per queued job. `/budget` is free. `scripts/stage-smoke.ts` checks the token, the budget, the queue, the counter, and pooled transactions. It waits for the next minute and then spends that minute's budget.

5. Run the Worker tests. They run on workerd and need the Postgres container from step 1.

   ```sh
   bun run --cwd apps/worker test
   ```

## Database schema

The Drizzle schema in `packages/db/src/schema.ts` is the source of truth. After changing it, generate a migration and apply it to the local Postgres.

```sh
cd packages/db
bun run generate
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep bun run migrate
```

Name the database in `DATABASE_URL`, because `migrate` has no default. The first migration creates the `vector` extension, which `drizzle-kit` does not emit.

## Cloudflare and Neon

Four workflows run the stages, and their jobs skip until the steps below are done. `preview` deploys stage `pr-<number>` for each pull request and runs `scripts/stage-smoke.ts` against it. `preview-destroy` destroys the stage when the pull request closes. `preview-reconcile` runs daily, or by hand with a dry-run option, and destroys any `pr-<number>` stage whose pull request is closed or gone. `deploy` runs on each push to `main`, or by hand on `main`. It deploys the database stack's stage `shared` and then stage `prod`. Each deploy first checks that its commit is still the head of `main` or of the pull request, so an older run never replaces a newer deploy.

1. Create a Cloudflare API token for the account with these permissions: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, Queues Write, Hyperdrive Write, Secrets Store Write, Account Settings Write, and Workers Tail Read. The Secrets Store permission is for Alchemy's state store, which keeps its keys there.

2. Create a Neon API key in the Neon console.

3. Add the token and key as GitHub Actions secrets, and the Cloudflare account ID as a variable. The variable turns the deploy jobs on.

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set NEON_API_KEY
   gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
   ```

4. Create Alchemy's state store in the account, as described in the next section.

5. Push to `main`. That deploy creates the Neon project `stargrep` in stage `shared`, and then `prod`. A pull request stage fails with a missing reference until it has run.

Every stage gets its own Neon branch of the project. Neon deletes a preview branch about two weeks after its last deploy, in case its destroy job never ran.

## State store maintenance

Alchemy keeps state in one store per Cloudflare account, and other projects in the account use it too. CI never creates or upgrades it. A deploy fails instead, with "State Store ... not found" or "is out of date". Create or upgrade the store by hand, with an account token that has the permissions above:

```sh
cd infra
CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> bunx alchemy state bootstrap --backend cloudflare
```

An upgrade changes the store for every project that uses it, so check with the account's other projects first.

To read a deployed stage's debug token, run this with the same credentials:

```sh
CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> bun scripts/stage-output.ts pr-<number> debugToken > debug-token
```
