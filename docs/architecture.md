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
| Database | Neon Postgres with pgvector. Drizzle 1.0 RC on `drizzle-orm/node-postgres` and `pg` through Hyperdrive, wrapped in a `Db` service. `drizzle-orm/effect-schema` derives Effect Schemas from tables. `drizzle-kit` 1.0 RC generates migrations, and CI runs them |
| Runtime | Cloudflare Workers, Hyperdrive in front of Neon |
| Jobs | Cloudflare Queues, Workflows, and cron triggers. Durable Objects for the per-token GitHub budget |
| Blob storage | Cloudflare R2 |
| Cache | Cloudflare KV and the Workers cache |
| UI | shadcn components on Base UI |
| Lint and format | Biome, plus the `@effect/language-service` TypeScript plugin for Effect rules |

Production code runs on the Workers runtime, not Bun. Code in `apps/` and every package they import must avoid Bun-only APIs. Bun runs installs, scripts, and tests.

oRPC 2.0 and Alchemy 2.0 are betas, and Drizzle 1.0 is a release candidate. Pin one exact version of each and upgrade on purpose.

`Db` exposes query functions from `packages/db`, each returning an Effect with a typed error. It never exposes the Drizzle database object, so core does not import Drizzle types and tests can use an in-memory `Db` layer. Transactions are a separate service. A driver change then touches only `packages/db`.

The `Db` service uses `pg` because Hyperdrive documents `pg` and because Better Auth's Drizzle adapter awaits queries, which only the promise-based driver supports. One driver then serves both core and auth. Drizzle's JIT row mapping stays off, because Workers block `new Function`.

TanStack DB owns all client state, so the browser has no Effect atoms or second store. The browser loads Effect only in code-split routes where it does real work, such as the search box, which debounces input, cancels stale requests, and merges local and semantic results with `Stream`. A probe bundle of that code measured about 34 KB gzipped. Public pages such as profiles, collections, and discovery pages load no Effect code. The browser does not decode responses from our own API. The oRPC client takes its types from the contracts through type-only imports.

App code talks to Postgres through Hyperdrive with a standard driver and uses no Neon-only APIs, so moving to another Postgres host is a dump and restore. Development and preview branches scale to zero. Production does not scale to zero, because a woken compute starts with an empty cache and the first vector searches then read from remote storage.

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
  config/           shared tsconfig and Biome plugins
infra/              Alchemy program: Cloudflare resources, Neon branches, stages
repos/              read-only source of effect, orpc, and alchemy at the pinned versions, for reference
scripts/            repo scripts, such as sync-repos.ts for repos/
```

Each feature folder in `core` holds its types, functions, and tests together. File names are kebab-case. A file is named after what it exports, such as `parse-query.ts` for `parseQuery`.

## Data model

Better Auth owns `user`, `session`, and `account`. Stargrep adds these tables.

| Table | Key | Holds |
|---|---|---|
| `github_accounts` | GitHub account ID | type (`user` or `org`), login, name, avatar, followers, public repos, total stars across owned repos, `claimed_by` user, star sync state |
| `repos` | GitHub repo ID | owner, name, description, topics, language, license, homepage, kind (`app`, `library`, `cli`, `framework`, `list`, and so on), created time, `pushed_at`, archived, README object ID, summary, keywords, `embedding halfvec`, embedding model, full-text column |
| `repo_metrics` | GitHub repo ID | current totals and 30-day and 90-day changes for stars, forks, commits, active contributors, new contributors, merged pull requests, closed issues, and releases, refreshed daily |
| `stars` | account ID and repo ID | `starred_at`, `unstarred_at`, source (`gharchive` or `api`) |
| `follows` | follower ID and followee ID | source (`github` or `stargrep`), created time |
| `collections` | ID | owner, slug, title, description, kind (`user` or `editorial`) |
| `collection_items` | collection ID and repo ID | note, position |
| `search_events` | ID | time, scope, query, result count, clicked repo, with no user identity |
| `api_usage` | key and day | request counts per procedure |

Sponsor tables come with the sponsors phase.

## GitHub access

GitHub limits each user token to 5,000 requests per hour. That budget is shared with every other app the user authorized. The app's own credentials get 5,000 per hour for public data. Stargrep stays inside these limits with five sources, cheapest first.

1. **Event archives.** Public star history with account, repo, and time, loaded without API calls. "Event sources" below explains which archive covers which period.
2. **Incremental sync.** A sync reads the star list newest first and stops at the first star it already has, so an unchanged account costs one request. ETags do not help here. Each star list page embeds live repo stats such as `pushed_at`, so its ETag changes when any of its 100 repos changes, even when no star changed.
3. **README object IDs.** GraphQL returns the README's object ID with the repo. Stargrep fetches and summarizes a README again only when that ID changes. A README fetch by object ID sends its stored ETag, and a `304` response does not count against the rate limit.
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

1. `sync-stars` fetches an account's star list newest first and stops at the first star it already has. A full sync runs on claim and weekly after that. Stars that are gone mark `unstarred_at`.
2. `enrich-repo` runs for repos that are new or whose README object ID changed. It stores the README in R2, writes the summary, keywords, and kind, and computes the embedding. It also fetches the facts events do not carry, such as license and homepage.
3. `import-events` is an hourly cron. It streams the hour's archive file, keeps star, fork, pull request, issue, and release events, writes them to R2 as Parquet, and loads new stars for served accounts into `stars`. A streaming parse of a full OpenDigger hour measured under 15 MB of heap and about 12 seconds of CPU, inside a Worker's 128 MB and the 15-minute limit for hourly crons. Writing Parquet needs a JavaScript Parquet writer in the Worker or a hand-off to a container.
4. `snapshot-repos` is a daily cron. It fetches facts events no longer carry, such as the commit history count, for tracked repos through batched GraphQL queries.
5. `rollup-metrics` is a daily job. It turns events and snapshots into weekly series per repo and writes current values and changes into `repo_metrics`. DuckDB does not run in Workers, so the rollup runs in a container or a scheduled CI job.

Bulk enrichment, such as a backfill of popular repos, uses the Gateway batch API for summaries and `embedMany` for embeddings.

## Search

Every search is hybrid. Full-text search and vector search run in one SQL query, and reciprocal rank fusion merges the two lists.

- **Your stars.** The candidate set is one account's stars, at most tens of thousands of rows. An exact vector scan over that set takes milliseconds, so this path uses no vector index.
- **Network.** The candidate set is the union of the stars of the accounts you follow. Results also rank by how many of those accounts starred each repo.
- **Global.** An HNSW index on `repos.embedding`. Filtered queries use pgvector's iterative index scans.

### Query plans

A query such as "open source apps like Wispr Flow with growing contributors" needs filters and a ranking, not only text matching. The planner turns each natural-language query into a typed `QueryPlan`.

- **Scope.** Your stars, your network, or everything.
- **Semantic text.** The text to embed. "Like Wispr Flow" becomes a description of what Wispr Flow does, because the product has no repo to compare against.
- **Filters.** Kind, license, language, archived, and thresholds on any metric.
- **Ranking.** Relevance alone, or relevance blended with a metric such as 90-day contributor growth.

The planner is a small model with structured output. It chooses metrics from a registry in `packages/core/src/search`, where each metric has an ID, a description the model reads, and the SQL expression behind it. The model never writes SQL. The plan is parsed at the boundary, and a plan that names an unknown metric is rejected.

Each result shows the values that ranked it, such as "+38% contributors in 90 days".

Plain keyword queries skip the planner. KV caches plans and query embeddings by normalized query text.

## AI providers

`packages/ai` has two ports, because they have different providers. `TextGeneration` turns a prompt into a value of an Effect Schema, for summaries, query plans, and later reranking. `Embeddings` turns texts into vectors. Core code imports only the ports.

| Port | Adapters | Where it runs |
|---|---|---|
| `TextGeneration` | AI Gateway, Claude Code CLI, fake | Gateway everywhere. Claude Code and the fake only on a developer's machine |
| `Embeddings` | AI Gateway, fake | Gateway everywhere. The fake only on a developer's machine |

Each entry point builds its layers from `@stargrep/ai/config`, which reads `AI_TEXT_PROVIDER` (`gateway`, `claude-code`, or `fake`) and `AI_EMBEDDINGS_PROVIDER` (`gateway` or `fake`). Both default to `gateway`. Every adapter decodes model output with the same schema and fails with the same typed errors: `AiOutputInvalid`, `AiRequestFailed`, `AiTimeout`, and `AiModelNotFound`. Error fields hold short facts such as an exit code or an HTTP status, never a prompt, README text, model output, or key.

**The Claude Code CLI is for local development only.** It runs `claude -p` with the developer's own subscription, for experiments, small eval runs, and summary samples. Anthropic's terms let a person use the unmodified Claude Code binary with their own subscription, but products and pipelines must use API keys. So deployed stages, CI, and bulk backfills always use the AI Gateway. The config enforces this. A provider other than `gateway` needs `STARGREP_MODE=local`, and it is refused whenever `CI` is set. Otherwise the layer fails at startup with `AiProviderNotAllowed`, before any model call.

**Embeddings from different models cannot be compared.** Each database has one embedding model and size, the one in `packages/ai/src/models.ts` when the database was created. Every embedding carries the ID of the model that made it, and every `repos` row stores it in `embedding_model`. Writes go through `requireModel`, which refuses a vector from any other model or size with `EmbeddingModelMismatch`. The database's model must live in the database, for example in a one-row settings table and a check on `embedding_model`, not in local config, so a local run with fake or foreign embeddings can never write into a database that production reads. Switching models means re-embedding every repo into a new column or a new database.

## Client

The web app loads the signed-in user's whole library into a TanStack DB collection. For 3,000 stars that is about 200 KB compressed. Filtering, sorting, and keyword search then run in the browser on each keystroke. Semantic results come from the server and merge into the same list.

## API and MCP

`packages/api` defines oRPC contracts. One router implements them. `apps/web` mounts that router three ways.

- The web app calls it with the typed oRPC client.
- `@orpc/openapi` serves it as REST, with a generated OpenAPI spec and a docs page.
- `@orpc/mcp` serves the procedures marked public as MCP tools over Streamable HTTP.

## Caching

| Layer | What it caches |
|---|---|
| Browser | The user's library in TanStack DB |
| Workers cache | Public profile pages, discovery pages, and OG images, with stale-while-revalidate |
| KV | Parsed queries and query embeddings |
| Postgres | Summaries and embeddings, shared across accounts |
| GitHub | README ETags, so an unchanged README returns `304` |

## Everything as code

The repo is the source of truth. Each concern has one file or folder that defines it.

| Concern | Source of truth |
|---|---|
| Workers, bindings, queues, crons, routes, DNS | The Alchemy program in `infra/`. Each pull request deploys to its own stage |
| Neon project and branches | The same Alchemy program. Each stage gets its own Neon branch |
| Database schema | Drizzle schema in `packages/db`, with migrations generated by `drizzle-kit` |
| API, REST, and MCP | oRPC contracts in `packages/api`. The OpenAPI spec and MCP tool list are generated from them |
| Environment variables | Effect `Config` definitions, validated at startup |
| Models and prompts | `packages/ai` |
| Search metrics | The metric registry in `packages/core/src/search` |
| Search quality | The query set and its expected results in the repo. CI fails a pull request that lowers recall |
| GitHub App | Its manifest in the repo. Creating the app from it takes one click in the browser |
| Design tokens | `packages/ui` |
| CI and deploys | GitHub Actions workflows. Only CI deploys to production |

Some things stay outside the repo. Secret values live in Cloudflare secrets and GitHub Actions secrets, and the repo holds only their names. Account creation, billing plans, and domain registration are one-time manual steps, listed in `docs/setup.md`.

## Testing

- `packages/core` tests use `bun test` with in-memory layers. They cover behavior, such as "an unstarred repo gets `unstarred_at`", not internal calls. Time runs on `TestClock`, so tests never sleep. `packages/testing` provides `it.effect`, `it.live`, and `it.layer` for `bun test` and is the only place that calls `Effect.runPromise` in tests. `docs/effect.md` section 7 shows how to use it.
- `packages/db` and the pipeline run integration tests against a Neon branch made for each test run.
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
- Whether `@orpc/mcp` covers OAuth for MCP clients, or Better Auth's OAuth provider plugin has to wrap it.
- Which embedding model to use. A bakeoff over the AI Gateway catalog scores a shortlist on a generated set of realistic queries with known answers, by recall at 10 and query latency. Switching later means re-embedding.
- Which model writes the summaries. The same query set compares candidates.
