# Setup

Install dependencies, start a local stage, and configure deployed stages with the steps below.

## Local checkout

1. Install Bun 1.4.3. The root `package.json` pins it in `packageManager`, and CI reads the version from there.

   ```sh
   curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
   ```

2. Install dependencies. The `postinstall` script runs `effect-tsgo patch`, which adds the Effect language service to the local TypeScript 7 install, so editors report Effect diagnostics.

   ```sh
   bun install --frozen-lockfile
   ```

3. Run the checks. This includes lint, custom lint fixtures, workspace typechecks, and both web bundle budgets. Turborepo caches the tasks.

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
   curl -X POST -H "authorization: Bearer $TOKEN" "http://localhost:1338/sleep?seconds=30"
   curl -H "authorization: Bearer $TOKEN" http://localhost:1338/budget
   curl -X POST -H "authorization: Bearer $TOKEN" -d '{"login":"octocat","mode":"full"}' http://localhost:1338/queue/sync-stars
   curl -X POST -H "authorization: Bearer $TOKEN" -d '{"repoId":1300192}' http://localhost:1338/queue/enrich-repo
   curl "http://localhost:1338/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
   bun scripts/stage-smoke.ts "dev_$USER" --backend local
   ```

   The routes spend from a budget of 300 units a minute: one per counter read, counter increment, transaction, or sleep, one per queued job, and one per message sent to `sync-stars` or `enrich-repo`. Those two routes send the request body as it is, so they also send malformed messages. `/sleep` runs `pg_sleep` through Hyperdrive and gives up after 10 seconds like the app, so `pg_stat_activity` shows whether the server stops the query. `/budget` is free. `scripts/stage-smoke.ts` checks the token, the budget, the queue, the counter, and pooled transactions. On a new stage, it first waits up to 60 seconds for `/budget` and a counter to answer, because the Durable Objects can fail for a few seconds after the deploy. A new workers.dev URL also answers with Cloudflare's own 404 page on some machines for over a minute, so each call that gets that page is sent again, for up to 60 seconds. A call whose connection drops before any answer is sent once more within the same 60 seconds. It waits for the next minute and then spends that minute's budget.

5. Run both apps' workerd suites. They need the Postgres container from step 1. The worker command runs the consumer suite and then bundles the real Worker for its runtime suite.

   ```sh
   bun run --cwd apps/worker test
   bun run --cwd apps/web test
   ```

## API

The web Worker serves the API from one oRPC contract in `packages/api`. Search needs a synced login. A missing login answers `ACCOUNT_NOT_SYNCED`. On a local stage without `AI_GATEWAY_API_KEY`, search answers `SERVICE_UNAVAILABLE`, except for a demo answer already in the cache. A preview searches with the stand-in models and needs no key, as "Models on previews" explains. Replace the URL with a stage's `Web` URL from its pull request comment to call a deployed stage.

```sh
WEB=http://localhost:1340
curl -X POST "$WEB/api/sync/octocat"
curl "$WEB/api/sync/octocat"
curl -X POST -H "content-type: application/json" -d '{"scope":{"kind":"stars","login":"octocat"},"q":"terminal dashboards"}' "$WEB/api/search"
curl "$WEB/api/repos/1300192"
curl "$WEB/openapi.json"
```

The search API takes its query in a JSON body. Shared page links can contain `?q=`, so those URLs can appear in request logs. `triggerSync` answers `waiting`, `queued`, `failed`, or `done`, or fails with `LOGIN_NOT_FOUND`, `SYNC_BUSY`, or `TOO_MANY_REQUESTS`. `syncStatus` reports `unknown`, `waiting`, `queued`, `failed`, or `done`. Triggers for a login already requested in the last 10 minutes answer with that request and queue nothing. Each caller may trigger about 5 syncs a minute, a soft limit that Cloudflare counts per location. Every REST error body has a `code` and a `traceId` in `data`, including a validation error and a body that is not JSON, and every response has an `x-trace-id` header. Each response's `Server-Timing` header gives the handler's total time and the procedure's time, in milliseconds.

To search from Claude Code, add the stage's MCP endpoint and ask it to search a synced login's stars:

```sh
claude mcp add --transport http stargrep "$WEB/mcp"
```

## Sign-in with GitHub

Sign-in needs a GitHub App. `.github/app-manifest.json` describes it: private until launch, webhook off, read-only access to email addresses, and callback URLs for `stargrep.com` and the local stage. Better Auth needs an email for each user, and GitHub hides most of them from the public profile.

1. Create the app from the manifest. With `gh` signed in as the repository's owner, run the script and press the button on the page it prints. It stores the client ID as the repository variable `STARGREP_GITHUB_APP_CLIENT_ID` and the client secret in each `--env` it names, without printing it.

   ```sh
   bun scripts/github-app.ts --env production
   ```

2. Add the Better Auth secret to `production`, and one proxy secret to both environments.

   ```sh
   openssl rand -base64 32 | gh secret set BETTER_AUTH_SECRET --env production
   secret=$(openssl rand -base64 32)
   for env in production preview; do printf %s "$secret" | gh secret set AUTH_PROXY_SECRET --env "$env"; done
   unset secret
   ```

3. Set the repository variable `AUTH_PROXY_ORIGIN` to prod's web origin. Preview stages then sign in through prod, need no client secret, and generate their own Better Auth secret.

   ```sh
   gh variable set AUTH_PROXY_ORIGIN --body https://stargrep.com
   ```

Each deploy also binds the client ID and the Better Auth secret to the main Worker, and the client secret when the stage signs in directly. The main Worker reads a signed-in user's token with them for the work that user started. A preview signs in through prod and has no client secret, so its main Worker cannot refresh an expired token.

A `prod` deploy fails without `STARGREP_GITHUB_APP_CLIENT_ID`, `STARGREP_GITHUB_APP_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, or `AUTH_PROXY_SECRET`. `AUTH_PROXY_ORIGIN` must be an https origin with no path. A preview deploy that has the client ID but neither `AUTH_PROXY_ORIGIN` nor the client secret fails too, so set the proxy origin before you remove a client secret from `preview`.

To sign in on the local stage, export `STARGREP_GITHUB_APP_CLIENT_ID`, `STARGREP_GITHUB_APP_CLIENT_SECRET`, and any `BETTER_AUTH_SECRET` before `bun run --cwd infra dev`. The manifest registers `http://localhost:1340/auth/callback/github`.

Signed in, the browser's session cookie also works on `/api/viewer` and `/api/library`, which answer `401` without it. Neither appears in `/openapi.json` or the MCP tool list.

## Database schema

The Drizzle schema in `packages/db/src/schema.ts` is the source of truth. After changing it, generate a migration and apply it to the local Postgres.

```sh
cd packages/db
bun run generate
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep bun run migrate
```

Name the database in `DATABASE_URL`, because `migrate` has no default. The first migration creates the `vector` extension, which `drizzle-kit` does not emit.

Deployed stages apply the same migrations through the stage's `Neon.Branch` in `apps/worker/src/database.ts`, before the Worker deploys. Alchemy records them in `__alchemy_migrations`, so never run `bun run migrate` against a stage branch.

To time the search queries, run `bun run --cwd packages/db bench`. It seeds 100,000 repos with random embeddings and 50 accounts of 5,000 stars into a `stargrep_bench` database, then prints the median and p95 of 100 interleaved runs of each query. It also adds one account of 3,000 stars, where half of all repos are pending and 44,000 of those are capped, and times its enrichment progress, its library, and one sweep.

## Enrich repos locally

`bun run --cwd packages/core enrich` runs the enrichment pipeline on your machine against a migrated database. It needs a GitHub token, the AI Gateway key, and `STARGREP_MODE=local`. READMEs go to `packages/core/.cache/blobs`.

```sh
export DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep
export GITHUB_TOKEN=... AI_GATEWAY_API_KEY=... STARGREP_MODE=local
bun run --cwd packages/core enrich repo effect-ts/effect
bun run --cwd packages/core enrich stars <login> --limit 200
```

The first command prints the summary, kind, and embedding size, and prints `unchanged` when you run it again. The second batch-enriches an account's newest stars through one AI Gateway batch job, which can take many minutes. A rerun inside the batch's 24-hour lease skips the repos the first run holds, so use `prefill` for a bulk run that must survive being stopped. `bun run --cwd packages/core bench <login>` times 20 single enrichments, each followed by an unchanged run, and splits each enrichment into model, embedding, GitHub, and local time.

## Prefill repos

`bun run --cwd packages/core prefill --ids <file>` summarizes every repo in a list through resumable provider batches, as "The prefill" in `docs/knowledge.md` explains. The list holds one `<numeric id> <owner>/<name>` per line. Stop it at any point and run it again, and it resumes the batches the first run sent without paying for them twice. A rerun right after a crash waits up to a minute for the crashed run's claim to go stale. `--out report.json` writes the run's outcomes, tokens, and statement counts, also when you stop the run with Ctrl-C. A SIGKILL writes none.

A Gateway batch run keeps its paid requests in the stage's R2 bucket and refuses to start without `PREFILL_R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. A refused start prints why and exits non-zero.

Two flags are off by default. `--ask-current` also asks repos whose summary is already current under the recipe, once each, and is for pilot 2 on a branch of prod only. `--resend-unknown` sends a recorded batch's request again when the Gateway says it does not know the batch, which pays for it again. Without it the driver keeps that manifest and its leases. The run prints one line for each manifest it keeps open, with what to do: restore a missing or unreadable request object from where the run stored it, or check the batch on the Gateway and rerun with `--resend-unknown` only if the batch is gone.

`--summary-model <id>` writes every summary with another Gateway model on the same prompt, such as `anthropic/claude-sonnet-5.5`, and needs `--adapter batch`. Each manifest and receipt records the model, and `pilot gates` prints which model wrote the answers. Run such a trial on a branch of its own. A repo already summarized under the current recipe counts as done, so on a branch that holds another model's answers the trial asks nothing.

```sh
bun run --cwd packages/core prefill --ids prefill.txt --adapter batch --chunk 250
```

With `AI_TEXT_PROVIDER=fake` and `AI_EMBEDDINGS_PROVIDER=fake` it pays for nothing: the stand-in answers, and its batches are files under `.cache/stand-in-batches`, so a killed run resumes as it would on the Gateway. `prefill-check` runs a kill, a resume, and a rerun beside the real sweep and consumer on a throwaway database. Never point either at a stage's branch with the stand-in models.

### Run pilot 2

Pilot 2 (`rollout.md` in the design) asks its 300 repos through the real Gateway batch path, so it pays for about 300 summaries. It runs on a temporary Neon branch of prod, never on prod itself. Nothing runs against a branch, so no sweep or queue consumer competes with the driver.

1. Branch prod after a deploy that includes the `prefill_owner` migration, so the branch has the manifest tables. Keep the branch's URL in a private file outside the repo, and delete the branch and the file when the pilot ends.
2. Set every variable the commands read, in the shell that runs them:

   ```sh
   export DATABASE_URL=...          # the pilot branch, never prod
   export GITHUB_TOKEN=...          # reads facts and READMEs
   export AI_GATEWAY_API_KEY=...    # the batch summaries and their embeddings
   export PREFILL_R2_BUCKET=...     # keeps the request objects that resume a paid batch
   export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...  # an R2 API token that can write that bucket
   ```

   Leave `AI_TEXT_PROVIDER` and `AI_EMBEDDINGS_PROVIDER` unset, so both use the Gateway. Prod's bucket works: the pilot adds READMEs under the keys enrichment uses, and request objects under `prefill/requests/`, which nothing in prod reads.
3. Check which recipe the prod repos are on: `select summary_recipe, count(*) from repos where summary is not null group by 1`. Repos already on the current recipe count as done, so the pilot asks them only with `--ask-current`.
4. Pick the sample from the prefill list. It makes no model call.

   ```sh
   bun run --cwd packages/core pilot sample --seed <seed> --list prefill.txt --out pilot2.txt
   ```

5. Run the prefill, stop it once with Ctrl-C after it sends its batches, and run it again. The second run resumes the batches the first sent. Both runs need `--ask-current`, or the 100 prod repos are skipped as done.

   ```sh
   bun run --cwd packages/core prefill --ids pilot2.txt --adapter batch --ask-current --out run-1.json
   bun run --cwd packages/core prefill --ids pilot2.txt --adapter batch --ask-current --out run-2.json
   ```

6. Print the gates. They read the branch, plus the reports for tokens, repaid items, and capture times.

   ```sh
   bun run --cwd packages/core pilot gates --sample pilot2.txt --runs run-1.json,run-2.json
   ```

Relative paths resolve from `packages/core`. "The prefill" in `docs/knowledge.md` says what each gate counts.

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

Four workflows run the stages, and their jobs skip until the steps below are done. `preview` deploys stage `pr-<number>` for each pull request from this repository and runs `scripts/stage-smoke.ts` against it. It also runs when the pull request gains or loses the `preview-ai` label, as "Models on previews" below explains. It skips a pull request that changes only `docs/` or Markdown files, and a running preview is never cancelled. A newer push or `preview-ai` label change waits as the one pending run and replaces any older pending run, then deploys what the pull request asks for when it starts. A failed preview deploy runs once more after 30 seconds, because Cloudflare can take a while to find a Worker or queue it just created. `preview-destroy` destroys the stage when the pull request closes. `preview-reconcile` runs daily, or by hand with a dry-run option, and destroys any `pr-<number>` stage whose pull request is closed or gone. `deploy` runs after push CI succeeds for a commit on `main`, or by hand on `main`, where it first requires successful push CI for that commit. It checks out that commit and checks that it is still the head of `main`. It deploys the database stack's stage `shared`, then stage `prod`, then runs read-only health and sync-status checks against `https://stargrep.com`. Preview deploys likewise check the pull request's current head before changing resources.

1. Create two Cloudflare API tokens for the account, one for prod and one for previews, each with these permissions: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, Queues Write, Hyperdrive Write, Secrets Store Write, Account Settings Write, and Workers Tail Read. The Secrets Store permission is for Alchemy's state store, which keeps its keys there. Each preview creates new Workers, and Cloudflare grants creating Workers only across the whole account, so the preview token can still change prod's Workers. It can also read prod's records in the shared state store. The prod token also needs four permissions on the zone `stargrep.com` only: Zone Read, Workers Routes Write, Dynamic URL Redirects Write, and Zone WAF Write. Zone WAF Write lets the deploy own the zone's rate limiting rule, see "Limits" in `docs/architecture.md`. The preview token gets no zone permissions.

2. Create two Neon API keys in the Neon console. Prod's key is an organization key, because the deploy from `main` creates the projects. The preview key is scoped to the project `stargrep-previews-us-east`, so create it after that deploy.

3. Create a fine-grained GitHub token with read access to public repositories and no other permission. Give it an expiration no longer than its owner's organizations allow, 366 days by default. Each preview stage's Worker syncs stars and fetches READMEs with it, and uses half of each hourly window. Prod uses the GitHub App's installation token instead, as "The app's installation token" below explains.

   If the Worker misses an organization's stars, check that organization's token policy. GitHub lists only the stars a token can read. An organization can block a fine-grained token of one of its members, for example a token that outlives the organization's limit. That token then reads none of the organization's repos, public ones included.

4. Create the GitHub environments. Only `main` can deploy to `production`. `preview` has no rules.

   ```sh
   echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
     | gh api -X PUT 'repos/{owner}/{repo}/environments/production' --input -
   gh api -X POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' -f name=main -f type=branch
   gh api -X PUT 'repos/{owner}/{repo}/environments/preview'
   ```

5. Add each environment's secrets, and the Cloudflare account ID as a repository variable. The variable turns the deploy jobs on. `deploy` reads secrets only from `production`, and the preview workflows only from `preview`. A workflow on any branch can read repository secrets and `preview` secrets, so keep prod's credentials only in `production` and keep no secrets at the repository level. Pull requests from forks get no Actions secrets by default, so their previews don't deploy, and `production` stays limited to `main` either way. Both environments can hold the same AI Gateway key. `preview` holds the personal GitHub token. `production` holds the App's private key, and the personal token too for as long as prod may need to go back to it. Each deploy binds `AI_GATEWAY_API_KEY` and the one GitHub credential its stage reads with to the Worker as secrets. A `prod` deploy fails without the AI Gateway key or the credential `STARGREP_GITHUB_SERVER_TOKEN` picks, with the App's client ID for the App. A pull request stage or a local stage deploys without them. Without the GitHub token, every GitHub call fails with `GitHubTokenMissing`, so each pipeline message goes to the dead-letter queue on its first attempt. A pull request stage binds the AI Gateway key only when its pull request opts in, as "Models on previews" below explains.

   ```sh
   for env in production preview; do
     for name in CLOUDFLARE_API_TOKEN NEON_API_KEY AI_GATEWAY_API_KEY; do
       gh secret set "$name" --env "$env"
     done
   done
   for env in production preview; do gh secret set STARGREP_GITHUB_TOKEN --env "$env"; done
   gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
   ```

6. Create Alchemy's state store in the account, as described in the next section.

7. Check that the zone `stargrep.com` is active in the account. Cloudflare Registrar created it with the domain. Deploys attach custom domains to it and never create or delete it.

8. Push to `main`. That deploy creates the Neon projects in stage `shared`, and then `prod`. A pull request stage fails with a missing reference until it has run.

Every stage gets its own Neon branch. Prod's branch is in the project `stargrep-us-east`, and each preview stage's branch is in `stargrep-previews-us-east`. Neon deletes a preview branch about two weeks after its last deploy, in case its destroy job never ran.

## Models on previews

Prod and local stages call the models. Each `pr-<number>` preview answers with deterministic fakes from `@stargrep/ai/stand-in` instead. Its deploy binds no `AI_GATEWAY_API_KEY`, even when the deploy's environment has one, and binds `STARGREP_AI_PROVIDER=fake`.

- A summary is the repo's description and the first 60 words of its README. Its keywords are the repo's topics. Its facts are only what the text states: kind and platform words in the description, the language, each topic, an alternative the description names, and a deprecation the description or the top of the README states. A repo whose description names no kind gets none. The answers go through the same capture and projection as real ones, so a preview mints subjects and shows atoms at no cost.
- An embedding hashes the words into 1,024 dimensions under the model ID `fake/hash-embedding`, so texts that share words land close together.
- The planner has no key, so search runs every sentence as typed and reports the plan as a fallback.

Opening a preview's home page still imports the demo account's real stars through GitHub, so the page shows real repos, icons, and import progress at no model cost. That import replaces seeding a stage by hand with synthetic accounts and fake vectors under the production model ID. The `stargrep_ai_tokens` metric names the model of every call it counts, and on a preview each model starts with `fake/`. Its Workers hold no AI Gateway key, so they can't reach the gateway at all.

`defaultAiProvider` in `stageSettings` (`packages/runtime/src/stage.ts`) is each stage's default, and `withStageAi` in `packages/runtime/src/ai-key.ts` applies it to the config of every resource the stack declares. Prod always calls the gateway and ignores `STARGREP_AI_PROVIDER`.

To call the real models on a preview, add the `preview-ai` label to its pull request. Remove the label to go back to the fakes. Each change runs the preview workflow at once, and the run reads the pull request's labels from GitHub right before it deploys, so a run queued before a label change deploys what the labels say now. An opted-in preview spends like prod, about $1.07 for every 1,000 repos it imports that no account has read yet, so remove the label as soon as the check is done.

A database keeps the embedding model of its first request, so a stage never changes provider in place. The workflow compares the provider the labels ask for with the `aiProvider` in the stage's output. When they differ, it destroys the stage and then deploys it fresh, both inside the stage's deploy lock. The stage is down for those few minutes and imports its stars again. Because the old branch is gone before the new one is created, a switch needs no spare branch in the preview project. A deploy writes the output last and a destroy deletes it last, so a stage whose output names no provider, such as one deployed before stages recorded it or one cut off mid-deploy, is recreated too. That is also how every preview deployed before the fakes existed moves to them, on its next run.

A pull request from a fork gets no secrets, so its preview job skips instead of failing.

A local stage keeps calling the gateway, because its database is the `stargrep` database every earlier run wrote real embeddings into, and it fails every model call with `AiKeyMissing` when the environment has no key. To run a local stage on the fakes, start from an empty Postgres volume, because the fakes can't share a database with real embeddings. This deletes the local database:

```sh
docker compose down --volumes && docker compose up --detach --wait
DATABASE_URL=postgres://stargrep:stargrep@127.0.0.1:54317/stargrep bun run --cwd packages/db migrate
STARGREP_AI_PROVIDER=fake bun run --cwd infra dev
```

## The app's installation token

Prod reads GitHub with the Stargrep GitHub App's installation token, as "GitHub access" in `docs/architecture.md` explains. The App needs no repository permission and its installation no repositories, because it reads only public data. The key never belongs in `preview`, which every branch can read, and any stage other than prod that sees `STARGREP_GITHUB_APP_PRIVATE_KEY` fails its deploy.

1. In the App's settings, under "Private keys", generate a private key. GitHub downloads it as a PEM file.
2. Install the App on the account that owns it. The App has no repository permissions, so GitHub asks for no repositories.
3. Store the key in `production` straight from the file, so it never passes through a terminal, a chat, or the clipboard, and delete the file.

   ```sh
   gh secret set STARGREP_GITHUB_APP_PRIVATE_KEY --env production < stargrep-app.private-key.pem
   rm stargrep-app.private-key.pem
   ```

4. Keep `STARGREP_GITHUB_TOKEN` in `production` until a prod deploy on the App has synced stars and enriched repos with no "Could not mint" or "GitHub forbade repos to the token" in the main Worker's logs. Then delete it.

   ```sh
   gh secret delete STARGREP_GITHUB_TOKEN --env production
   ```

The repository variable `STARGREP_GITHUB_SERVER_TOKEN` picks prod's server token. Unset, the prod deploy uses the App. To go back to the personal token without a code change, set it to `pat` and run the deploy workflow again. Set it back to `app`, or delete it, to return to the App. A `pat` deploy needs `STARGREP_GITHUB_TOKEN` in `production`, and the share follows the token: 0.9 on the App, 0.5 on the personal token.

```sh
gh variable set STARGREP_GITHUB_SERVER_TOKEN --body pat
gh workflow run deploy.yml --ref main
```

A mint GitHub refuses fails each GitHub call with `GitHubTokenMissing` and logs "Could not mint a GitHub App installation token" with the reason: `key` for a key that does not import or sign, `jwt-rejected` for a revoked key, `forbidden` for a suspended App, or `installation` for an App not installed on its owner's account.

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
