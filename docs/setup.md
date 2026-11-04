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
   docker compose up --detach --wait
   bun test --parallel
   ```

   Use `--parallel`, not `--concurrent`. Under `--concurrent`, Bun gives the `packages/testing` helper no way to interrupt a test that times out, so its finalizers never run.

## Editor

VS Code and editors based on it pick up `.vscode/settings.json`. It turns on the native TypeScript 7 server from `node_modules/typescript` and sets Biome as the formatter. Accept the prompt to use the workspace TypeScript version, and install the Biome extension when the editor recommends it.

For other editors, run `bunx effect-tsgo setup --help` to see the setup for Neovim and Emacs.

## Local stage

`alchemy dev` runs the whole stage on your machine with no cloud account. It runs the Worker, the debug Worker, and the web Worker in workerd and simulates the queue, KV, R2, the Durable Objects, the cron, the rate limits, and Hyperdrive. Only Neon has no local mode, so the local stage points Hyperdrive at a Postgres container.

1. Start Postgres 17 with pgvector. It listens on `127.0.0.1:54317` and creates the `vector` extension on first start.

   ```sh
   docker compose up --detach --wait
   ```

2. Run the stage. Alchemy prints each URL, the Worker on `http://localhost:1337`, the debug Worker on `http://localhost:1338`, and the web Worker on `http://localhost:1340` unless the ports are taken, and keeps local state in `infra/.alchemy/`.

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
   curl -X POST -H "authorization: Bearer $TOKEN" -d '{"login":"octocat","mode":"full"}' http://localhost:1338/queue/sync-stars
   curl -X POST -H "authorization: Bearer $TOKEN" -d '{"repoId":1300192}' http://localhost:1338/queue/enrich-repo
   curl "http://localhost:1338/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
   bun scripts/stage-smoke.ts "dev_$USER" --backend local
   ```

   The routes spend from a budget of 300 units a minute: one per counter read, counter increment, or transaction, one per queued job, and one per message sent to `sync-stars` or `enrich-repo`. Those two routes send the request body as it is, so they also send malformed messages. `/budget` is free. `scripts/stage-smoke.ts` checks the token, the budget, the queue, the counter, and pooled transactions. On a new stage, it first waits up to 60 seconds for `/budget` and a counter to answer, because the Durable Objects can fail for a few seconds after the deploy. A new workers.dev URL also answers with Cloudflare's own 404 page on some machines for over a minute, so each call that gets that page is sent again, for up to 60 seconds. A call whose connection drops before any answer is sent once more within the same 60 seconds. It waits for the next minute and then spends that minute's budget.

5. Run the Worker tests. They run on workerd and need the Postgres container from step 1.

   ```sh
   bun run --cwd apps/worker test
   ```

## API

The web Worker serves the API from one oRPC contract in `packages/api`. Search needs a synced login and the AI Gateway key, so on a local stage without them it answers `SERVICE_UNAVAILABLE`. Replace the URL with a stage's `Web` URL from its pull request comment to call a deployed stage.

```sh
WEB=http://localhost:1340
curl -X POST "$WEB/api/sync/octocat"
curl "$WEB/api/sync/octocat"
curl -X POST -H "content-type: application/json" -d '{"login":"octocat","q":"terminal dashboards"}' "$WEB/api/search"
curl "$WEB/api/repos/1300192"
curl "$WEB/openapi.json"
```

Search takes its query in a JSON body, so the query never appears in a URL, a request log, or Cloudflare's request span. `triggerSync` answers `queued`, and `syncStatus` answers `done` once the sync has run or `failed` if it could not, such as for a login GitHub does not know. Each caller may trigger 5 syncs a minute. Every error body has a `code` and a `traceId`. Each response's `Server-Timing` header gives the handler's total time and the procedure's time, in milliseconds.

To search from Claude Code, add the stage's MCP endpoint and ask it to search a synced login's stars:

```sh
claude mcp add --transport http stargrep "$WEB/mcp"
```

## Database schema

The Drizzle schema in `packages/db/src/schema.ts` is the source of truth. After changing it, generate a migration and apply it to the local Postgres.

```sh
cd packages/db
bun run generate
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep bun run migrate
```

Name the database in `DATABASE_URL`, because `migrate` has no default. The first migration creates the `vector` extension, which `drizzle-kit` does not emit.

Deployed stages apply the same migrations through the stage's `Neon.Branch` in `apps/worker/src/database.ts`, before the Worker deploys. Alchemy records them in `__alchemy_migrations`, so never run `bun run migrate` against a stage branch.

To time the search queries, run `bun run --cwd packages/db bench`. It seeds 100,000 repos with random embeddings and 50 accounts of 5,000 stars into a `stargrep_bench` database, then prints the median and p95 of 100 interleaved runs of each query.

## Enrich repos locally

`bun run --cwd packages/core enrich` runs the enrichment pipeline on your machine against a migrated database. It needs a GitHub token, the AI Gateway key, and `STARGREP_MODE=local`. READMEs go to `packages/core/.cache/blobs`.

```sh
export DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep
export GITHUB_TOKEN=... AI_GATEWAY_API_KEY=... STARGREP_MODE=local
bun run --cwd packages/core enrich repo effect-ts/effect
bun run --cwd packages/core enrich stars <login> --limit 200
```

The first command prints the summary, kind, and embedding size, and prints `unchanged` when you run it again. The second batch-enriches an account's newest stars through one AI Gateway batch job, which can take many minutes. Stop it and run it again, and it waits for the same job. `bun run --cwd packages/core bench <login>` times 20 single enrichments, each followed by an unchanged run, and splits each enrichment into model, embedding, GitHub, and local time.

## Search

`search` runs one query over an account's stars and prints the plan, the time spent in the planner, the embedding, and the database, and each result with the values that ranked it. It needs `AI_GATEWAY_API_KEY` and a `DATABASE_URL` that names a migrated database with the account in it. It caches plans and query embeddings in `packages/core/.cache/search`, so a repeated query makes no model call.

```sh
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep_recall \
  bun run --cwd packages/core search recall-eval "rust library for terminal dashboards"
```

`bun run evals/recall.ts` creates `stargrep_recall` with the account `recall-eval`, as `docs/evals.md` describes. `bun run evals/search-bench.ts` times 50 interleaved searches of each kind, keyword and planned, each with a warm and a cold cache, and splits the time into local work, the database, the planner, and the embedding. It takes one or more logins, shares one warm cache across them, and times a `select 1` before each round, so a slow database shows up on its own. Against the `stargrep_bench` database, pass `--fake-embeddings bench/random-1024` so queries embed locally with the model ID that database stores.

```sh
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep_bench \
  bun run evals/search-bench.ts bench-1 --fake-embeddings bench/random-1024
```

## Cloudflare and Neon

Four workflows run the stages, and their jobs skip until the steps below are done. `preview` deploys stage `pr-<number>` for each pull request and runs `scripts/stage-smoke.ts` against it. A failed preview deploy runs once more after 30 seconds, because Cloudflare can take a while to find a Worker or queue it just created. `preview-destroy` destroys the stage when the pull request closes. `preview-reconcile` runs daily, or by hand with a dry-run option, and destroys any `pr-<number>` stage whose pull request is closed or gone. `deploy` runs on each push to `main`, or by hand on `main`. It deploys the database stack's stage `shared` and then stage `prod`. Each deploy first checks that its commit is still the head of `main` or of the pull request, so an older run never replaces a newer deploy.

1. Create two Cloudflare API tokens for the account, one for prod and one for previews, each with these permissions: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, Queues Write, Hyperdrive Write, Secrets Store Write, Account Settings Write, and Workers Tail Read. The Secrets Store permission is for Alchemy's state store, which keeps its keys there. Each preview creates new Workers, and Cloudflare grants creating Workers only across the whole account, so the preview token can still change prod's Workers. It can also read prod's records in the shared state store.

2. Create two Neon API keys in the Neon console. Prod's key is an organization key, because the deploy from `main` creates the projects. The preview key is scoped to the project `stargrep-previews-us-east`, so create it after that deploy.

3. Create a fine-grained GitHub token with read access to public repositories and no other permission. Each stage's Worker syncs stars and fetches READMEs with it, and uses half of each hourly window.

4. Create the GitHub environments. Only `main` can deploy to `production`. `preview` has no rules.

   ```sh
   echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
     | gh api -X PUT 'repos/{owner}/{repo}/environments/production' --input -
   gh api -X POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' -f name=main -f type=branch
   gh api -X PUT 'repos/{owner}/{repo}/environments/preview'
   ```

5. Add each environment's secrets, and the Cloudflare account ID as a repository variable. The variable turns the deploy jobs on. `deploy` reads secrets only from `production`, and the preview workflows only from `preview`. A workflow on any branch can read repository secrets and `preview` secrets, so keep prod's credentials only in `production` and keep no secrets at the repository level. Pull requests from forks get no Actions secrets by default, so their previews don't deploy, and `production` stays limited to `main` either way. Both environments can hold the same AI Gateway key and GitHub token. Each deploy binds `AI_GATEWAY_API_KEY` and `STARGREP_GITHUB_TOKEN` to the Worker as secrets. A `prod` deploy fails without either secret. A pull request stage or a local stage deploys without them. There, every GitHub call fails with `GitHubTokenMissing` and every model call with `AiKeyMissing`, so each pipeline message goes to the dead-letter queue on its first attempt.

   ```sh
   for env in production preview; do
     for name in CLOUDFLARE_API_TOKEN NEON_API_KEY AI_GATEWAY_API_KEY STARGREP_GITHUB_TOKEN; do
       gh secret set "$name" --env "$env"
     done
   done
   gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
   ```

6. Create Alchemy's state store in the account, as described in the next section.

7. Push to `main`. That deploy creates the Neon projects in stage `shared`, and then `prod`. A pull request stage fails with a missing reference until it has run.

Every stage gets its own Neon branch. Prod's branch is in the project `stargrep-us-east`, and each preview stage's branch is in `stargrep-previews-us-east`. Neon deletes a preview branch about two weeks after its last deploy, in case its destroy job never ran.

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

Without an API token, sign in with the `cf` CLI and pass its session token. `cf auth whoami` prints the signed-in account and its ID. The session token lives in the `cf` config file and expires after about an hour, and `cf` refreshes it on its next command.

```sh
cf auth whoami
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_API_TOKEN="$(python3 -c 'import json, os; print(json.load(open(os.path.expanduser("~/Library/Preferences/cloudflare/config/default.json")))["oauth_token"])')"
bun scripts/stage-output.ts pr-<number> debugUrl
bun scripts/stage-output.ts pr-<number> debugToken > debug-token
```

The config file path above is the one `cf` uses on macOS. `cf auth whoami` prints the path it reads from as `authSource`.
