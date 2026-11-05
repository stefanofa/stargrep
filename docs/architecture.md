# Stargrep architecture

This doc explains how Stargrep is built and why. `docs/product.md` explains what it does. Once code exists, the Drizzle schema and the oRPC contracts are the reference, and this doc only explains the decisions behind them.

## Principles

- **Headless core.** All domain logic lives in `packages/core` as Effect programs. Each program declares the services it needs, such as `Db`, `GitHub`, `TextGeneration`, `Embeddings`, `Queue`, and `BlobStore`. Core has no imports from TanStack Start, Cloudflare, or oRPC. `bun test` runs it with in-memory layers and no network.
- **Effect conventions.** `docs/effect.md` sets how services, layers, errors, schemas, config, tracing, and tests are written. It follows T3 Code's conventions, adapted to Workers and `bun test`.
- **Platforms are layers.** Each service has one production layer, such as `Queue` on Cloudflare Queues, and one in-memory layer for tests. Moving a service to another platform means writing one new layer. Core does not change.
- **Parse at the boundary.** Effect Schema parses GitHub responses, environment config, model output, and API input into domain types. Code inside trusts those types and does not validate again.
- **One schema library.** Every schema in our code is an Effect Schema. Our code never imports zod, even though some dependencies install it. Schemas leave our code in two places, each with one bridge. oRPC takes Effect schemas directly through `@orpc/effect`. `packages/ai` wraps a schema with `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` before passing it to the AI SDK or to a coding-agent CLI.
- **Shared repos, per-user stars.** Each repo is fetched, summarized, and embedded once, however many accounts starred it. An account's stars are rows that point at shared repos.
- **GitHub numeric IDs as keys.** Accounts and repos are keyed by GitHub's numeric IDs. Logins and repo names change on rename.
- **Idempotent pipeline steps.** Every ingestion step converges to the same state when it runs twice. Queues retry, so steps must survive retries.

## Stack

Versions were checked on 2026-11-03. Pin exact versions in `package.json`.

| Concern | Choice |
|---|---|
| Monorepo | Turborepo 2.11 |
| Package manager, scripts, tests | Bun 1.4 and `bun test` |
| Core runtime | Effect 4.1: services and layers, Effect Schema, typed errors, retries and schedules, OpenTelemetry tracing |
| Infrastructure | Alchemy 2.0 beta, pinned to `2.0.0-beta.85`, an open source TypeScript infra tool built on Effect. State lives in `Cloudflare.state()` |
| App framework | TanStack Start 1.169 |
| Client data | TanStack DB 1.0 RC |
| API, REST, MCP | oRPC 2.0 beta, with `@orpc/openapi`, `@orpc/mcp`, and `@orpc/effect`. Every `@orpc/*` package pins the same beta |
| AI | Two ports, `TextGeneration` and `Embeddings`, in `packages/ai`. Production uses the Vercel AI SDK 7 with `@ai-sdk/gateway`: structured output through `generateText` with `Output`, embeddings through `embedMany`, and bulk summaries through the Gateway batch API. Local development can generate text through the Claude Code CLI. See "AI providers". `effect/ai` was considered, but its model modules are marked unstable and it has no Gateway batch API |
| Activity analytics | Public GitHub events stored in R2 as Parquet, partitioned by day, and rolled up daily into Postgres. See "Event sources" for where events come from |
| Type checking | TypeScript 7 with `@effect/tsgo`, which runs the Effect language service rules from the command line. TypeScript 6 with `effect-language-service patch` is the fallback |
| Worker tests | `@cloudflare/vitest-plugin` with vitest for code that must run on workerd. `bun test` for everything else, scoped by `bunfig.toml` |
| Auth | Better Auth 1.7, GitHub sign-in through a GitHub App, `@better-auth/oauth-provider` for MCP |
| Database | Neon Postgres with pgvector. Drizzle 1.0 RC on `drizzle-orm/node-postgres` and `pg` through Hyperdrive, wrapped in a `Db` service. `drizzle-orm/effect-schema` derives Effect Schemas from tables. `drizzle-kit` 1.0 RC generates migrations, and each stage's Neon branch applies them during deploy |
| Runtime | Cloudflare Workers, Hyperdrive in front of Neon |
| Jobs | Cloudflare Queues, Workflows, and cron triggers. Durable Objects for the per-token GitHub budget |
| Blob storage | Cloudflare R2 |
| Cache | Cloudflare KV and the Workers cache |
| UI | shadcn components on Base UI |
| Lint and format | Biome, plus the `@effect/language-service` TypeScript plugin for Effect rules |

Production code runs on the Workers runtime, not Bun. Code in `apps/` and every package they import must avoid Bun-only APIs. Bun runs installs, scripts, and tests.

oRPC 2.0 and Alchemy 2.0 are betas, and Drizzle 1.0 is a release candidate. Pin one exact version of each and upgrade on purpose.

`Db` exposes query functions from `packages/db`, each returning an Effect with a typed error. It never exposes the Drizzle database object, so core does not import Drizzle types. Tests use `layerMemory` from `@stargrep/db/memory`, which runs the same migrations and query code on PGlite, Postgres compiled to WASM with pgvector, inside the test process. Transactions are a separate service. A driver change then touches only `packages/db`.

The `Db` service uses `pg` because Hyperdrive documents `pg` and because Better Auth's Drizzle adapter awaits queries, which only the promise-based driver supports. One driver then serves both core and auth. Drizzle's JIT row mapping stays off, because Workers block `new Function`.

TanStack DB owns all client state, so the browser has no Effect atoms or second store. The browser loads Effect only in code-split routes where it does real work, such as the search box, which debounces input, cancels stale requests, and merges local and semantic results with `Stream`. A probe bundle of that code measured about 34 KB gzipped. Public pages such as profiles, collections, and discovery pages load no Effect code. The browser does not decode responses from our own API. The oRPC client takes its types from the contracts through type-only imports.

App code talks to Postgres through Hyperdrive with a standard driver and uses no Neon-only APIs, so moving to another Postgres host is a dump and restore. Development and preview branches scale to zero. Production does not scale to zero, because a woken compute starts with an empty cache and the first vector searches then read from remote storage.

Every stage's database runs in `aws-us-east-1`, and the main Worker and the web Worker have the placement hint `aws:us-east-1`, so Cloudflare runs their `fetch` handlers in the data center nearest that region. A request crosses the distance to the caller once, and its queries stay near the database. Placement moves only `fetch` handlers. Cron triggers, queue consumers, and Durable Objects run where Cloudflare starts them, and the debug Worker has no placement.

## Repo layout

```
apps/
  web/              TanStack Start app, and the handlers for oRPC, REST, and MCP
  worker/           queue consumers, workflows, and crons
packages/
  core/             domain logic, one folder per feature
    src/repos/      enrichment, summaries, embeddings
    src/stars/      sync, diffing, unstar detection
    src/search/     query parsing, hybrid search, ranking
    src/social/     follows, digest, network search
    src/profiles/   taste profile, similar taste, claiming
    src/sponsors/   placements and matching
  api/              oRPC contracts and router
  db/               Drizzle schema, migrations, query functions
  github/           GitHub client, token budget, GH Archive reader
  ai/               TextGeneration and Embeddings ports, provider adapters, models, prompts
  auth/             Better Auth config
  ui/               design tokens and components
  testing/          bun test helpers that stand in for it.effect and it.layer
  telemetry/        the tracer wrapper that drops span results, the OTLP and Workers tracers built with it, and a span collector for tests and scripts
  runtime/          config and layers every Worker shares: the optional secret reader and Db on node-postgres
  config/           shared tsconfig and Biome plugins
infra/              Alchemy stacks, providers, state store, and which Workers each stage deploys
repos/              read-only source of effect, orpc, and alchemy at the pinned versions, for reference
scripts/            repo scripts, such as sync-repos.ts for repos/
```

Each feature folder in `core` holds its types, functions, and tests together. File names are kebab-case. A file is named after what it exports, such as `parse-query.ts` for `parseQuery`.

## Data model

Better Auth owns `user`, `session`, `account`, and `verification`, declared in `packages/db/src/auth-schema.ts` so they migrate with the rest of the schema. Stargrep adds these tables.

| Table | Key | Holds |
|---|---|---|
| `github_accounts` | GitHub account ID | type (`user` or `org`), login, name, avatar, followers, public repos, total stars across owned repos, how many repos it starred when it last signed in, `claimed_by` user, star sync state, including the time of the latest full star snapshot |
| `repos` | GitHub repo ID | owner, name, GitHub node ID, description, topics, language, license, homepage, kind (`app`, `library`, `cli`, `framework`, `list`, and so on), created time, `pushed_at`, archived, README object ID from the latest facts fetch, summary and the README object ID it describes, keywords, `embedding halfvec`, embedding model, full-text column, how many times enrichment failed since the repo was last read and when it last failed |
| `repo_metrics` | GitHub repo ID | current totals and 30-day and 90-day changes for stars, forks, commits, active contributors, new contributors, merged pull requests, closed issues, and releases. Enrichment writes the star and fork totals each time it fetches a repo's facts, and the daily rollup writes every column. `refreshed_at` is the time of the latest write from either |
| `stars` | account ID and repo ID | `starred_at`, `unstarred_at`, the time of the latest observation, source (`gharchive` or `api`). Every star event carries the time it was observed: an API sync's start, or an archive event's own time. An event or snapshot observed at or before the row's latest observation, or at or before the account's latest full snapshot, changes nothing |
| `follows` | follower ID and followee ID | source (`github` or `stargrep`), created time |
| `collections` | ID | owner, slug, title, description, kind (`user` or `editorial`) |
| `collection_items` | collection ID and repo ID | note, position |
| `search_events` | ID | time, scope, query, result count, clicked repo, with no user identity |
| `api_usage` | key and day | request counts per procedure |
| `sync_requests` | lowercase login | when a sync was last requested, and its outcome (`pending` or `failed`) |

Sponsor tables come with the sponsors phase.

## GitHub access

GitHub limits each user token to 5,000 requests per hour. That budget is shared with every other app the user authorized. The app's own credentials get 5,000 per hour for public data. Stargrep stays inside these limits with five sources, cheapest first.

1. **Event archives.** Public star history with account, repo, and time, loaded without API calls. "Event sources" below explains which archive covers which period.
2. **Incremental sync.** A sync reads the star list newest first and stops at the first star it already has, so an unchanged account costs one request. ETags do not help here. Each star list page embeds live repo stats such as `pushed_at`, so its ETag changes when any of its 100 repos changes, even when no star changed.
3. **README object IDs.** GraphQL returns the README's object ID with the repo. Stargrep fetches and summarizes a README again only when that ID changes. An object ID names fixed content, so R2 keeps each README under its ID, and a README already in R2 costs no request.
4. **The user's own token.** A signed-in user's sync uses their token, capped at a share of their remaining budget read from `x-ratelimit-remaining`.
5. **The app's credentials.** Signed-out lookups of accounts that GH Archive does not cover yet.

A user's token is used only for work that user started. Stargrep never pools user tokens to crawl other accounts.

`packages/github` sends requests one after another per token, as GitHub's best practices ask. This keeps it under the secondary limit of 100 concurrent requests. It also sets the floor for a full sync. The REST star list is the fastest source, at about 1.35 s of GitHub server time per page of 100 and slower on deep pages, so 3,000 stars take about 45 s. GraphQL's `starredRepositories` takes about 2.5 s per page. An in-memory lock cannot do this, because many Worker isolates run at once. Each token gets a Durable Object that sends its requests in order and tracks its remaining budget from the response headers.

## Event sources

No single public source has every star.

- **GH Archive** is complete until 2025-05-24. It holds about 554 million star events, according to ClickHouse's full copy. After that date its collector captures a shrinking share, about 1% of stars by late 2026, and since September 2026 it has no push events. From 2015 on, star and fork events carry numeric account and repo IDs. Events from 2012 to 2014 carry logins only and need ID resolution.
- **The OpenDigger mirror** uses the same file format from 2026-09-06 and captures roughly 90 to 98% of stars, measured against GH Archive and the API. An hourly file is about 415 MB gzipped with about 650,000 events. Stargrep treats it as a best-effort input, not a dependency.
- **The GitHub API** gives an account's full star list with `starred_at` through `users/{login}/starred`. A repo's stargazer list is closed: `repos/{owner}/{repo}/stargazers` returns 404, and GraphQL returns only `stargazerCount`. So stars can be rebuilt one account at a time, never one repo at a time.

Between 2025-05-24 and 2026-09-05 no archive is complete. Per-account sync fills that window for the accounts Stargrep serves. Metrics that depend on that window are marked incomplete instead of showing a false dip.

Full star history lives in R2 as Parquet, about 5 GB for all of it. Postgres `stars` holds only the accounts and repos Stargrep serves. Holding all of it in Postgres would take 64 to 74 GB, mostly rows nobody reads.

Since October 2025 push events carry no commit list or count, so commit metrics come from the GraphQL commit history count of each tracked repo, fetched daily in batches. Merged pull requests are counted from both `action: merged` and `action: closed` with `merged: true`, because the payload changed in 2025.

## Ingestion pipeline

Each step is a queue message type. Each consumer is idempotent.

1. `sync-stars` fetches an account's star list newest first. It stops at the first star older than a star the last completed sync saw unchanged, so it reads every star that shares that star's `starred_at`. A full sync runs on claim and weekly after that. Stars that are gone mark `unstarred_at`. The list pages by offset, so a full read counts the stars through GraphQL before and after. When the counts differ, the read shifted, and the sync writes what it read but skips the unstars and does not record the run. A star added and another removed at different page boundaries during one read leave the counts equal, so that read can hide one star until the next full sync. An org cannot star repos, so its count is zero without a GraphQL request. A finished sync only moves the account's sync time forward, so an older run that finishes last cannot pull the stop line back. It enqueues the repos that need enrichment after it reads the last page, because enrichment shares the token's one request at a time and would otherwise hold it between the sync's pages.
2. `enrich-repo` runs for repos that are new or whose README object ID changed. It stores the README in R2, writes the summary, keywords, and kind, and computes the embedding. It also fetches the facts events do not carry, such as license and homepage.
3. `import-events` is an hourly cron. It streams the hour's archive file, keeps star, fork, pull request, issue, and release events, writes them to R2 as Parquet, and loads new stars for served accounts into `stars`. A streaming parse of a full OpenDigger hour measured under 15 MB of heap and about 12 seconds of CPU, inside a Worker's 128 MB and the 15-minute limit for hourly crons. Writing Parquet needs a JavaScript Parquet writer in the Worker or a hand-off to a container.
4. `snapshot-repos` is a daily cron. It fetches facts events no longer carry, such as the commit history count, for tracked repos through batched GraphQL queries.
5. `rollup-metrics` is a daily job. It turns events and snapshots into weekly series per repo and writes current values and changes into `repo_metrics`. DuckDB does not run in Workers, so the rollup runs in a container or a scheduled CI job.

Bulk enrichment, such as a backfill of popular repos, uses the Gateway batch API for summaries and `embedMany` for embeddings. The batch path serves the CLI and backfills only, because a batch job can take minutes to hours.

`apps/worker` runs steps 1 and 2 as queue consumers. `src/queues.ts` declares each queue, its dead-letter queue, and its consumer settings.

- A consumer decodes each message, calls one service method, and settles the message. Success acks it. `afterFailure` in `src/consumers/settle.ts` maps every failure tag to one settlement, and a new tag fails typecheck until it has a row.
- A failure that can pass on a second try, such as a lost database connection, a deadlock, a GitHub 5xx, a GitHub 403 that names no rate limit, or a model timeout, retries up to five times a minute apart, and then Cloudflare moves the message to the dead-letter queue. An enrichment failure that counts against the repo instead starts its backoff, so those retries settle as `Backoff` and the sweep owns the next try. A failure that cannot, such as a missing token or key, an unknown account, or a body that does not decode, goes to the dead-letter queue on its first attempt. A failure while the runtime layers build, such as a lost database connection or an embedding model conflict, fails the whole batch before any message is settled, and Alchemy retries every message in it.
- A spent token budget or a GitHub rate limit is not a failure. GitHub names the time the limit lifts, or asks for a minute when a secondary rate limit names no time, so the consumer sends the message again with that delay and acks the original. A long pause then spends none of the five retries.
- The `enrich-repo` consumer takes up to 100 messages per batch and runs one batch at a time. The Worker's text-generation layer has no batch API, so `enrichRepos` answers each repo with its own model call, and it reads each repo id once. A repo several accounts starred arrives once per account, and a later batch finds it enriched.
- GitHub answers each repo in a facts batch on its own. A repo it does not return, or reports as `FORBIDDEN`, settles as gone, and the rest of the batch enriches. The client logs the node IDs of forbidden repos. Any other GraphQL error fails the whole batch.
- A repo is read once it has a summary of its current README and an embedding, which is `pendingEnrichment` in `packages/db/src/schema.ts`, negated. `EnrichRepo` counts a repo's own failures when each batch chunk finishes: gone or forbidden, no node ID, a README GitHub no longer serves, a 4xx other than 403 on its README, or model answers that do not decode. A failure every repo would hit, such as a missing token or key, an outage, a rate limit, or a batch that aborts, never counts. Each counted failure adds one to `enrich_failures` and sets `enrich_retry_at` from `retryDelays` in `packages/core/src/repos/enrich-retry.ts`. A failure before the retry time has passed is a copy of one already counted and changes nothing. Saving the embedding sets both back. A pending repo with `enrichFailureCap` failures, 3, counts as failed, so a library's progress can reach its end.
- An incremental sync lists only new stars, so it never sends a pending repo again. A cron in `apps/worker/src/crons.ts` runs `EnrichRetry.sweep` every 10 minutes instead, with a 5-minute timeout. It sends at most 100 pending repos under the cap whose retry time has passed, the earliest first and then repos that never failed, such as one whose message was lost. A repo waits 10 minutes after its first failure and an hour after its second, so a repo GitHub forbids costs at most three lookups, each one node in a batched GraphQL request. A message that reaches a repo before its retry time, such as a queue retry of a counted failure or a second sweep send, settles as `Backoff` with no GitHub call. A partial index holds only pending repos under the cap, so capped repos never slow the sweep. A full sync or another account's first sync still sends a capped repo again.
- Each dead-letter queue has a consumer that logs the message ID, its attempts, and the IDs in its body, or only the body's type when the body does not decode. An enrich dead letter changes no failure count, because only `EnrichRepo` knows whether a failure was the repo's own.

The `GitHubGate` Durable Object holds the Worker's GitHub token. Every GitHub request from every isolate goes through it, so it sends them one at a time. It keeps the rate-limit windows GitHub reported in its storage and takes its share of each window from `GITHUB_BUDGET_SHARE`, so a restart keeps the windows and a new share applies at once. The share is 0.5 unless a preview stage sets a number above 0 and at most 1, and a `prod` deploy fails with any other value. Requests and replies cross the RPC boundary as plain data, and the token never leaves the object. A pull request stage may deploy without a token. It then binds no `GitHubGate`, and every GitHub call fails with `GitHubTokenMissing`.

## Search

Every search is hybrid. Full-text search and vector search run in one SQL query, and reciprocal rank fusion merges the two lists. Full text matches the words the user typed. The vector side embeds the planner's description of a matching repo, or the query itself when the planner is skipped. A repo whose name or `owner/name` equals a keyword query ranks first.

- **Your stars.** The candidate set is one account's stars, at most tens of thousands of rows. An exact vector scan over that set takes milliseconds, so this path uses no vector index.
- **Network.** The candidate set is the union of the stars of the accounts you follow. Results also rank by how many of those accounts starred each repo.
- **Global.** An HNSW index on `repos.embedding`. Filtered queries use pgvector's iterative index scans.

### Query plans

A query such as "open source apps like Wispr Flow with growing contributors" needs filters and a ranking, not only text matching. The planner turns each natural-language query into a typed `QueryPlan`.

- **Scope.** Your stars, your network, or everything. The caller sets it, never the model, so a plan cannot widen a search. Only your stars runs in the first milestone. The other scopes fail with `SearchScopeUnavailable`.
- **Semantic text.** The text to embed. "Like Wispr Flow" becomes a description of what Wispr Flow does, because the product has no repo to compare against.
- **Filters.** Kind, license, language, archived, starred date, and bounds on any metric. A bound is strict or inclusive, so "more than 200 stars" leaves out a repo with exactly 200. A language filter matches a repo written in that language or tagged with it as a topic, because a Python package manager is often written in Rust. A JavaScript filter also matches TypeScript.
- **Ranking.** Relevance alone, or the best matches reordered by a metric such as 90-day contributor growth. A metric never lifts a repo that did not match into the results.

The planner is `anthropic/claude-haiku-5.5` with structured output and reasoning turned off. With reasoning on, a plan took 2.1 to 4.6 seconds from a laptop, and with it off 1.2 to 2.1 seconds. It chooses metrics from a registry in `packages/core/src/search/metric-registry.ts`. Each entry holds an ID, the description the model reads, and a family and variant, such as stars and 90-day growth, that `packages/db` turns into SQL over `repo_metrics`. The model never writes SQL. The plan is parsed at the boundary, and a plan that names an unknown metric is rejected. When the planner fails or returns a plan that does not parse, search runs the query as typed.

The planner sets only the filters a query states, and code holds it to that after decoding. A kind filter stays only when the query restricts the kind with a word such as "only" or "not". The model returns each language with the words from the query that named it, such as Python with "питоне". A language stays only when those words appear in the query and are the language's name, one of its aliases, or a word in a non-Latin script, such as "питоне" or "パイソン". In Chinese, Japanese, and Thai, which have no spaces between words, the words match anywhere in the text. So a language named in any script stays, and one quoted from a framework, such as Java from "spring boot", is dropped. A quote in a non-Latin script is trusted as naming the language, so a transliterated framework name, such as "लारावेल" for Laravel, can still keep a language filter. `packages/core/src/search/vocabulary.ts` holds the languages and their topic names and the words that send a query to the planner. In the recall eval, filters the model inferred dropped relevant repos, such as Rich for "python framework for text user interfaces", because the summarizer called it a library. `docs/evals.md` has the numbers.

Each result shows the values that ranked it, such as "+38% contributors in 90 days".

`QueryPlanner.plan` sets `search.plan.source` on its span to `keyword`, `cache`, `model`, or `fallback`, and counts each plan in `stargrep_search_plans`. A fallback also sets `search.plan.failure` to the error tag, such as `AiTimeout`, so traces show how often Haiku's tail latency sends a search to the typed text.

A repo name, an `owner/name`, or two plain words skip the planner. A query with a word that can name a filter, such as a language, a kind, a license, "only", "more", or a number, goes to the planner, so "only MIT libraries" keeps its filters. The `SearchCache` port caches plans and query embeddings under a SHA-256 of the normalized query text. Each entry records when it expires, 30 days after it was written, so an old entry is a miss on every backend. A corrupt entry is a miss too. A plan with a date filter is reused only on the day it was planned, because "starred last year" depends on today. Tests use the memory layer. The web Worker keeps entries in a KV namespace and sets each one's KV expiration from its TTL, at least the 60 seconds KV accepts.

## AI providers

`packages/ai` has two ports, because they have different providers. Production summarizes with `anthropic/claude-haiku-5.5` and embeds with `voyage/voyage-4` at 1,024 dimensions. `docs/evals.md` records the bakeoff that chose them. The query planner uses `anthropic/claude-haiku-5.5` with reasoning off through its own `TextGeneration` layer, `layerPlannerTextGeneration`, with a 4-second timeout and no retries. `TextGeneration` turns a prompt into a value of an Effect Schema, for summaries, query plans, and later reranking. `Embeddings` turns texts into vectors. Core code imports only the ports.

| Port | Adapters | Where it runs |
|---|---|---|
| `TextGeneration` | AI Gateway, Claude Code CLI, fake | Gateway everywhere. Claude Code and the fake only on a developer's machine |
| `Embeddings` | AI Gateway, fake | Gateway everywhere. The fake only on a developer's machine |

An adapter only sends the request and returns the raw output and token counts. The port's `make` does the rest for every adapter: it applies the adapter's timeout, decodes the output with the request's Effect Schema, counts tokens in `stargrep_ai_tokens`, and opens the span. So every adapter fails with the same typed errors: `AiOutputInvalid`, `AiRequestFailed`, `AiUnavailable`, `AiTimeout`, and `AiModelNotFound`. `AiUnavailable` is a failure the provider marks as worth a retry, such as a rate limit or a 5xx. The port retries it three times with jittered backoff from one second, around each model call, so no caller retries it again. Error fields hold short facts such as an exit code or an HTTP status, never a prompt, README text, model output, or key.

`TextGeneration.generateBatch` answers many prompts with one schema and returns one result per prompt, so one bad answer fails only its own repo. The gateway adapter submits one AI Gateway batch job through the AI SDK's experimental batch API, which accepts text requests only. The job's idempotency key is a hash of the requests, so a run that stops while it waits finds the same job again instead of paying for a second one. A replayed job returns its stored failures too, so a failed item gets one direct call. Adapters without a batch API answer the prompts one at a time.

Deployed code uses the layers from `@stargrep/ai/gateway`. `layer` serves both ports with the models in `models.ts` and reads `AI_GATEWAY_API_KEY` through `layerProviderConfig`. `layerModels` serves both ports with a given provider and options. Each Worker reads the key once and passes it to `layerModelsForKey`, the main Worker's summaries and embeddings with no batch API, or `layerSearchForKey`, the web Worker's planner and embeddings. Without a key, or with an empty one, as on a local stage, both serve the ports with calls that fail with `AiKeyMissing`. Local tools use `layer` from `@stargrep/ai/local` instead. It reads `AI_TEXT_PROVIDER` (`gateway`, `claude-code`, or `fake`) and `AI_EMBEDDINGS_PROVIDER` (`gateway` or `fake`), both `gateway` by default, and needs Bun to spawn the CLI.

**The Claude Code CLI is for local development only.** It runs `claude -p` with the developer's own subscription, for experiments, small eval runs, and summary samples. Anthropic's terms let a person use the unmodified Claude Code binary with their own subscription, but products and pipelines must use API keys. So deployed stages, CI, and bulk backfills always use the AI Gateway. Four checks enforce this.

| Check | What it stops |
|---|---|
| The `@stargrep/ai` exports map has no `./claude-code` entry | Code outside the package cannot build the harness without `@stargrep/ai/local` |
| `@stargrep/ai/local` fails with `AiProviderNotAllowed` at startup unless `STARGREP_MODE=local` and `CI` is unset | A local tool run in CI, or with the wrong environment, cannot reach the harness or the fakes |
| The Biome rule `packages/config/no-local-ai-import.grit` | Code in `apps/`, except tests, cannot import `@stargrep/ai/local`, `@stargrep/ai/fake`, `@stargrep/ai/summarize.fake`, or `@stargrep/ai/claude-code` |
| The gateway layer's type does not require `ChildProcessSpawner` | A Worker that uses it never needs a process spawner, so typecheck catches a Worker wired to the local layer |

**Embeddings from different models cannot be compared.** Each database has one embedding model and size. The one-row `embedding_settings` table records them, and a migration creates it. When the `Db` layer starts, it reads that row. In a fresh database it writes the configured model once, and when the configured model or size differs from the stored one, the layer fails with `EmbeddingModelConflict` before any query runs. Reading the row costs one query per `Db` build. The Worker builds `Db` per request, because a Hyperdrive socket opened in one request cannot serve another, and passes a `Ref` it keeps for the isolate's lifetime. So only an isolate's first request reads the row. So a local run configured with fake or foreign embeddings can never write into a database that production reads. Every embedding carries the ID of the model that made it, every `repos` row stores it in `embedding_model`, and `saveEmbedding` refuses a vector from any model other than the stored one with `EmbeddingModelMismatch`. No `Db` function changes the stored model. To switch models on purpose, write a migration that clears `embedding` and `embedding_model` on every repo and updates `embedding_settings`, then re-embed every repo with the new model.

## Sign-in

People sign in with GitHub through a GitHub App, whose manifest is `.github/app-manifest.json`. `packages/auth` configures Better Auth on `pg` and `drizzle-orm/node-postgres`, the same driver as `Db`, with its own pool for each request that connects only when a query runs. Better Auth serves `/auth/*`, because `/api/*` is the REST API. The session cookie carries a five-minute cache of the session, so most API calls read no session row. Linking a GitHub account reads the session row, so a cookie copied before sign-out cannot start a link. Better Auth stores the user's GitHub token encrypted.

A new session imports the GitHub account with the user's own token: `GET /user` for the login and profile, and one GraphQL call for the number of repos the account starred. It claims the `github_accounts` row for the user and queues a sync. If that import fails, the first `viewer` or `library` call runs it again. The sync page compares the library's size with the starred count to show progress.

A GitHub App cannot match callback URLs by wildcard, and each preview stage has its own workers.dev host. So previews sign in through prod with Better Auth's `oAuthProxy` plugin. The preview sends GitHub's redirect to prod's callback and packs its own state, PKCE verifier included, into GitHub's `state`, encrypted with `AUTH_PROXY_SECRET`. Prod exchanges the code and redirects to the preview with the profile and tokens encrypted for 60 seconds. The preview creates the user and session in its own database. Prod creates neither. `AUTH_PROXY_ORIGIN` decides: unset, a stage signs in directly with the client secret, and set, a stage proxies through that origin and never reads the client secret.

Any branch's workflow can read the `preview` environment, so the design assumes the proxy secret leaks. Two guards on prod keep that leak inside preview databases. Prod installs the plugin without its endpoints and keeps only the hooks that forward a preview's sign-in, so prod has no route that turns a profile encrypted with the proxy secret into a session, under any provider ID. Prod forwards a sign-in only to its own origin or to a preview Worker of this account, so a forged state cannot send a user's GitHub token to another host.

## Client

The web app loads the signed-in user's whole library into a TanStack DB collection, one snapshot per load. For 3,000 stars that is about 200 KB compressed. Filtering, sorting, and keyword search then run in the browser on each keystroke, through a live query that matches every word of the query. Semantic results come from the server through an Effect `Stream` that waits for typing to pause and interrupts the request for a query typed over. They append after the keyword results, so no tile the user can see moves. While a sync runs, the page reloads the library every two seconds. Each library repo carries `read`, which says whether search by meaning can find it yet. To keep those flags fresh, a client polls `syncStatus` every few seconds while `state` is `queued` or `enrichment.read + enrichment.failed < enrichment.total`, and reloads the library when `enrichment.read` changes. The total is 0 until the sync writes stars, so the `state` check keeps the poll going. Each poll runs two small reads and one aggregate over the account's stars, at the same time.

The landing page loads no Effect code. The search route renders only in the browser, in its own chunk, which holds Effect, TanStack DB, and the oRPC client.

## API and MCP

`packages/api` defines the oRPC contract, one router that implements it, the wire errors, and one instrumentation middleware. `apps/web` is a TanStack Start app on Workers, and `src/server.ts` serves the router three ways before TanStack Start sees the request.

- `/rpc` serves the typed oRPC client.
- `/api` serves REST, and `/openapi.json` is the OpenAPI document generated from the contract.
- `/mcp` serves every procedure as an MCP tool over Streamable HTTP, named by its `operationId`.

The procedures are `search`, `triggerSync`, `syncStatus`, `getRepo`, `viewer`, and `library`. The first four are public. `viewer` and `library` read the session cookie and answer `UNAUTHORIZED` without one, so they stay out of the MCP tool list and the OpenAPI document until MCP clients can sign in.

- **Errors.** Every outcome other than success is a tagged error, such as `AccountNotSynced` from search, `RepoNotFound` from `Db`, or `SyncRateLimited` from the limiter. The router catches once per procedure and maps each tag to a wire error through one table, so a new tag fails typecheck until it has a row. A wire error has a stable `code`, such as `ACCOUNT_NOT_SYNCED` or `SERVICE_UNAVAILABLE`, a fixed message, and the call's `traceId` in `data`. `packages/api/src/errors.ts` holds each code's status and message. A failure outside the table becomes `INTERNAL_SERVER_ERROR` with the trace ID and no detail. oRPC decodes a request body before any middleware runs, so the web Worker's handler interceptor gives a body it cannot decode `BAD_REQUEST` with the request's trace ID, and MCP's own JSON-RPC errors, such as a parse error, carry it in `error.data`. Every API response, the OpenAPI document included, also has an `x-trace-id` header. A path under `/api`, `/rpc`, or `/mcp` that matches no procedure answers `NOT_FOUND` in that transport's error shape with the trace ID, and a failure outside the API answers `INTERNAL_SERVER_ERROR` the same way.
- **Services per request.** A Hyperdrive socket cannot outlive its request, so the web Worker builds `Db`, search, and sync services for each request, and only once a procedure has validated its input. A database outage then fails a search with `SERVICE_UNAVAILABLE`, while validation, the tool list, and the OpenAPI document keep working.
- **Tracing.** The middleware opens `Api.<procedure>` under the request's `Web.<transport>` span and sets `api.transport` and `stargrep.trace_id`. No span holds the query, the plan, or results. Cloudflare's own request span and invocation log record the full URL, so search takes its query in a POST body. Each response carries a `Server-Timing` header with the handler's total time and the procedure's time, so a stage measures transport overhead apart from the work.
- **Sync.** `triggerSync` claims the login's row in `sync_requests` and queues an incremental `sync-stars` message only when the claim wins. The claim is one `insert … on conflict do update … where` statement, which takes the row only when the login has no request or its request is at least 10 minutes old, so of many triggers at once exactly one queues a job. A login synced in the last 10 minutes is not queued again either, and a request older than a day is forgotten. When the queue refuses the message, or the main Worker dead-letters it, the row is marked `failed`. The message carries its request time, and a dead letter marks the row only while the row still holds that request, so a late dead letter never fails a newer claim. Each claim also deletes up to 100 requests older than a day, so the table holds about a day of logins. `syncStatus` reads the row and the account's star sync time and says `queued`, `failed`, `done`, or `unknown`. Both procedures also return `enrichment`, the login's current stars counted as `total`, `read`, and `failed`. The router reads it by login in one query over `stars` joined to `repos`, beside the sync status. Repos are shared, so `read` can start above zero. Right after `triggerSync` the total is 0, and reading goes on after `state` leaves `queued`, so reading is finished only when `state` is not `queued` and `read + failed == total`.
- **Limits.** Workers rate limiting lets each caller IP trigger 5 syncs a minute and all callers together 60. Cloudflare counts these per location and only approximately, so they turn away most of a burst but are not a cap. Two bounds hold: the per-login claim above, and the GitHub budget. The web Worker has no GitHub token and no `GitHubGate` binding, so every GitHub request a trigger causes spends the gate's budget share in the main Worker. Zone-level WAF rate limiting arrives with the stargrep.com zone. A limiter that fails answers `SERVICE_UNAVAILABLE`.

`@orpc/mcp` registers tools and does no auth. The MCP SDK checks bearer tokens with a verifier the app supplies, serves protected resource metadata, and answers with the `WWW-Authenticate` challenge, but it is not an authorization server. So MCP sign-in needs Better Auth's OAuth provider plugin as the authorization server, and `/mcp` verifies the token and passes `authInfo` to the MCP handler.

## Caching

| Layer | What it caches |
|---|---|
| Browser | The user's library in TanStack DB |
| Workers cache | Public profile pages, discovery pages, and OG images, with stale-while-revalidate |
| KV | Query plans and query embeddings, through the `SearchCache` port |
| Postgres | Summaries and embeddings, shared across accounts |
| R2 | README text by object ID, so GitHub serves each README once |

## Everything as code

The repo is the source of truth. Each concern has one file or folder that defines it.

| Concern | Source of truth |
|---|---|
| Workers, bindings, queues, crons, routes, DNS | The Alchemy program. Each resource is declared in the module that binds it, such as `apps/worker/src`, and `infra/` holds the stacks, providers, state, and which Workers each stage deploys. Each pull request deploys to its own stage |
| Neon projects and branches | `infra/database.run.ts` owns the projects. Each stage's branch is declared with the Hyperdrive that binds it, in `apps/worker/src/database.ts`, which also decides that `prod` keeps its branch on destroy and that preview branches expire |
| Database schema | Drizzle schema in `packages/db`, with migrations generated by `drizzle-kit`. Each stage's Neon branch applies them before its Worker deploys |
| API, REST, and MCP | oRPC contracts in `packages/api`. The OpenAPI spec and MCP tool list are generated from them |
| Environment variables | Effect `Config` definitions, validated at startup |
| Models and prompts | `packages/ai` |
| Search metrics | `packages/core/src/search/metric-registry.ts` names each metric for the planner, and `packages/db/src/queries/search.ts` maps its family to `repo_metrics` columns. Both use `MetricFamily`, so the compiler keeps `MetricFamily`, `metricColumns`, and `nouns` in step |
| Search quality | The query set and its expected results in the repo. CI fails a pull request that lowers recall |
| GitHub App | Its manifest in the repo. Creating the app from it takes one click in the browser |
| Design tokens | `packages/ui` |
| CI and deploys | GitHub Actions workflows. Only CI deploys to production |

Some things stay outside the repo. Secret values live in Cloudflare secrets and GitHub Actions environment secrets, and the repo holds only their names. Only jobs on `main` can read the `production` environment's secrets. Previews read separate credentials from the `preview` environment. Account creation, billing plans, and domain registration are one-time manual steps, listed in `docs/setup.md`.

### Stages

The Alchemy program has two stacks, so no app stage's state holds a Neon project. `infra/database.run.ts` owns the projects in its only stage, `shared`. `infra/alchemy.run.ts` is the app stack, deployed once per stage: `pr-<number>` for each pull request and `prod` for `main`. Each app stage references one project and owns one branch of it, so destroying a stage deletes its branch and never the project. `prod` uses `stargrep-us-east`, and every preview stage uses `stargrep-previews-us-east`, both in `aws-us-east-1`, so a Neon key scoped to the previews project can't reach prod's branch. Only the deploy from `main` deploys `shared`. A pull request stage fails with a missing reference until `main` has deployed once.

`prod` deploys only the Worker, its database, the queues, R2 bucket, and Durable Object the pipeline needs, and the web Worker with its KV namespace. It serves on `stargrep.com`, and `www.stargrep.com` redirects there. The Worker holds the custom domain, and a zone route sends every path to the web Worker, because routes take precedence over custom domains. The web Worker passes `/health`, with any query string, to the Worker through a service binding, so the health check still reads the Worker's database connection. Cloudflare matches route patterns against the query string too, so a `/health` route would miss `/health?x=1`. Prod has no workers.dev URLs, so every request passes the zone's rules. Every other stage serves only on its workers.dev URLs and also deploys a debug Worker with a queue and consumer, KV, R2, two Durable Objects, and an hourly cron, so the checks in `docs/setup.md` can drive them. Its routes take a bearer token that the stack generates per stage, and a Durable Object caps them at 300 units of work a minute.

Deployed stages keep Alchemy state in the Cloudflare account through `Cloudflare.state()`. Under `alchemy dev`, state stays in `infra/.alchemy/` and the stage declares no Neon resources, so a local stage needs no credentials.

## Testing

- `packages/core` tests use `bun test` with in-memory layers. They cover behavior, such as "an unstarred repo gets `unstarred_at`", not internal calls. Time runs on `TestClock`, so tests never sleep. `packages/testing` provides `it.effect`, `it.live`, and `it.layer` for `bun test` and is the only place that calls `Effect.runPromise` in tests. `docs/effect.md` section 7 shows how to use it.
- `packages/db` runs each query test twice, on PGlite and on Postgres 17 with pgvector through `pg`. The `pg` run creates and migrates a database for each test file in the local container from the root `compose.yaml`, and CI starts the same container. The PGlite run starts each database from a migrated data directory that the first test process builds and keeps in the temp directory, keyed by the PGlite and pgvector versions and the migration files, because initdb takes seconds on a busy machine. The pipeline runs integration tests against a Neon branch made for each test run.
- `apps/web` and `apps/worker` tests run on workerd through `@cloudflare/vitest-plugin`. The first test in each file waits about 9 seconds while the module graph loads, so the config sets `testTimeout` to 30 seconds. Workerd test files are named `*.workerd-test.ts`, which `bun test` never matches from any folder, and the vitest config includes only that pattern. `bunfig.toml` ignores `repos/`, so a root `bun test` runs every other `*.test.ts` in the repo.
- `bun test` runs with `--parallel`, not `--concurrent`, so a test that times out still interrupts its fiber and runs its finalizers.

## Settled by prototypes

These ran locally on 2026-11-03, with no cloud account.

- **Alchemy 2.0 beta covers every resource Stargrep uses.** Under `alchemy dev` with Bun, one local stage ran a Worker with a queue producer and consumer, a Durable Object, KV, R2, a cron, a Workflow, and Hyperdrive to a local Postgres. Neon projects, branches, roles, and connection strings and GitHub secrets exist in its source. State needs an explicit store. Stargrep uses `Cloudflare.state()`, so CI needs only a Cloudflare token.
- **TanStack Start, oRPC 2.0 beta, and Effect run together on workerd.** One procedure with an Effect Schema input and an Effect handler answered over RPC, REST, and MCP, and the OpenAPI spec generated. The client bundle stayed free of Effect with type-only contract imports. One runtime import of the contract added about 27 KB gzipped, so a lint rule enforces type-only imports. Every `@orpc/*` package pins `2.0.0-beta.48`, because npm's `latest` tags mix 1.x and different betas.
- **`drizzle-orm/effect-postgres` works on workerd with `prepare: false`, and Stargrep does not adopt it.** With default prepared statements, 68 of 360 transactions failed behind a transaction-mode pooler. Better Auth's adapter fails on it. `pg` measured no slower and serves both core and auth.
- **`drizzle-kit` does not emit `CREATE EXTENSION vector`.** The first migration adds it by hand.
- **The `bun test` helper works.** It lives in `packages/testing`, and its tests cover what the prototype checked.

## Open technical questions

- Whether Hyperdrive with `pg` behaves on Neon as it did locally, and what latency, pgvector version, and cold start Neon gives. The first deployed stage answers it.
- Whether the OpenDigger mirror's license and uptime allow Stargrep to rely on it, and whether it is worth running an own collector instead.
- Whether the hourly import writes Parquet inside the Worker with a JavaScript writer or hands off to a container.
