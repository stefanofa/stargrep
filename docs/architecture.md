# Starring architecture

This doc explains how Starring is built and why. `docs/product.md` explains what it does. Once code exists, the Drizzle schema and the oRPC contracts are the reference, and this doc only explains the decisions behind them.

## Principles

- **Headless core.** All domain logic lives in `packages/core` as Effect programs. Each program declares the services it needs, such as `Db`, `GitHub`, `Ai`, `Queue`, and `BlobStore`. Core has no imports from TanStack Start, Cloudflare, or oRPC. `bun test` runs it with in-memory layers and no network.
- **Effect conventions.** `docs/effect.md` sets how services, layers, errors, schemas, config, tracing, and tests are written. It follows T3 Code's conventions, adapted to Workers and `bun test`.
- **Platforms are layers.** Each service has one production layer, such as `Queue` on Cloudflare Queues, and one in-memory layer for tests. Moving a service to another platform means writing one new layer. Core does not change.
- **Parse at the boundary.** Effect Schema parses GitHub responses, environment config, model output, and API input into domain types. Code inside trusts those types and does not validate again.
- **One schema library.** Every schema in our code is an Effect Schema. Our code never imports zod, even though some dependencies install it. Schemas leave our code in two places, each with one bridge. oRPC takes Effect schemas directly through `@orpc/effect`. The `Ai` service wraps a schema with `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` before passing it to the AI SDK.
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
| Infrastructure | Alchemy 2.0 beta, an open source TypeScript infra tool built on Effect. Pulumi is the fallback. A phase 0 prototype confirms the choice |
| App framework | TanStack Start 1.169 |
| Client data | TanStack DB 1.0 RC |
| API, REST, MCP | oRPC 2.0 beta, with `@orpc/openapi`, `@orpc/mcp`, and `@orpc/effect`. Every `@orpc/*` package pins the same beta |
| AI | Vercel AI SDK 7 with `@ai-sdk/gateway`, behind an `Ai` service. Structured output uses `generateText` with `Output`, embeddings use `embedMany`, and bulk summaries use the Gateway batch API. `effect/ai` was considered, but its model modules are marked unstable and it has no Gateway batch API |
| Activity analytics | GH Archive events stored in R2 as Parquet and rolled up daily into Postgres. The rollup engine (DuckDB or Cloudflare Basin) is decided in phase 0 |
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

The `Db` service uses `pg` because Hyperdrive documents `pg` and because Better Auth's Drizzle adapter awaits queries, which only the promise-based driver supports. One driver then serves both core and auth. Drizzle 1.0 RC also ships `drizzle-orm/effect-postgres`, which runs queries as Effects on `@effect/sql-pg`. That client opens its own sockets instead of using `pg`, and Hyperdrive does not list it, so phase 0 tests it before core adopts it. Drizzle's JIT row mapping stays off, because Workers block `new Function`.

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
  github/           GitHub client, token budget, ETag store, GH Archive reader
  ai/               model registry, prompts, embedding helper
  auth/             Better Auth config
  ui/               design tokens and components
  testing/          bun test helpers that stand in for it.effect and it.layer
  config/           shared tsconfig and Biome config
infra/              Alchemy program: Cloudflare resources, Neon branches, stages
```

Each feature folder in `core` holds its types, functions, and tests together. File names are kebab-case. A file is named after what it exports, such as `parse-query.ts` for `parseQuery`.

## Data model

Better Auth owns `user`, `session`, and `account`. Starring adds these tables.

| Table | Key | Holds |
|---|---|---|
| `github_accounts` | GitHub account ID | type (`user` or `org`), login, name, avatar, followers, public repos, total stars across owned repos, `claimed_by` user, star sync state and ETag |
| `repos` | GitHub repo ID | owner, name, description, topics, language, license, homepage, kind (`app`, `library`, `cli`, `framework`, `list`, and so on), created time, `pushed_at`, archived, README object ID, summary, keywords, `embedding halfvec`, embedding model, full-text column |
| `repo_metrics` | GitHub repo ID | current totals and 30-day and 90-day changes for stars, forks, commits, active contributors, new contributors, merged pull requests, closed issues, and releases, refreshed daily |
| `stars` | account ID and repo ID | `starred_at`, `unstarred_at`, source (`gharchive` or `api`) |
| `follows` | follower ID and followee ID | source (`github` or `starring`), created time |
| `collections` | ID | owner, slug, title, description, kind (`user` or `editorial`) |
| `collection_items` | collection ID and repo ID | note, position |
| `search_events` | ID | time, scope, query, result count, clicked repo, with no user identity |
| `api_usage` | key and day | request counts per procedure |

Sponsor tables come with the sponsors phase.

## GitHub access

GitHub limits each user token to 5,000 requests per hour. That budget is shared with every other app the user authorized. The app's own credentials get 5,000 per hour for public data. Starring stays inside these limits with five sources, cheapest first.

1. **GH Archive.** Every public star since 2011, with account, repo, and time. An hourly job loads new star events. A one-time backfill loads history. This source makes no API calls.
2. **Conditional requests.** Starring stores the ETag of each star list it fetched. A `304` response does not count against the rate limit.
3. **README object IDs.** GraphQL returns the README's object ID with the repo. Starring fetches and summarizes a README again only when that ID changes.
4. **The user's own token.** A signed-in user's sync uses their token, capped at a share of their remaining budget read from `x-ratelimit-remaining`.
5. **The app's credentials.** Signed-out lookups of accounts that GH Archive does not cover yet.

A user's token is used only for work that user started. Starring never pools user tokens to crawl other accounts.

`packages/github` sends requests one after another per token, as GitHub's best practices ask. This keeps it under the secondary limit of 100 concurrent requests. An in-memory lock cannot do this, because many Worker isolates run at once. Each token gets a Durable Object that sends its requests in order and tracks its remaining budget from the response headers.

## Ingestion pipeline

Each step is a queue message type. Each consumer is idempotent.

1. `sync-stars` fetches an account's star list newest first and stops at the first star it already has. A full sync runs on claim and weekly after that. Stars that are gone mark `unstarred_at`.
2. `enrich-repo` runs for repos that are new or whose README object ID changed. It stores the README in R2, writes the summary, keywords, and kind, and computes the embedding. It also fetches the facts events do not carry, such as license and homepage.
3. `import-gharchive` is an hourly cron. It keeps star, fork, push, pull request, issue, and release events for indexed repos, writes them to R2 as Parquet, and loads new stars into `stars`.
4. `rollup-metrics` is a daily cron. It turns the events into weekly series per repo and writes current values and changes into `repo_metrics`.

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
| GitHub | ETags, so unchanged lists return `304` |

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

- `packages/core` tests use `bun test` with in-memory layers. They cover behavior, such as "an unstarred repo gets `unstarred_at`", not internal calls. Time runs on `TestClock`, so tests never sleep. `packages/testing` is the only place that calls `Effect.runPromise` in tests.
- `packages/db` and the pipeline run integration tests against a Neon branch made for each test run.
- `apps/web` and `apps/worker` need tests that run on the Workers runtime. `bun test` does not emulate it. Settle the runner with a prototype in phase 0.

## Open technical questions

- How many star events GH Archive holds in total, and what the activity backfill costs. BigQuery dry runs report the bytes scanned before anything is spent.
- Which rollup engine turns the Parquet events into `repo_metrics`: DuckDB in a scheduled job, or Cloudflare Basin.
- Whether TanStack Start, Hyperdrive, and Neon work together on Workers without friction. A phase 0 prototype settles it.
- Whether `@orpc/mcp` covers OAuth for MCP clients, or Better Auth's OAuth provider plugin has to wrap it.
- Whether Alchemy 2.0 beta covers every resource we use: Workers, Queues, Workflows, KV, R2, Hyperdrive, crons, DNS, and Neon branches for each stage. Its home page shows Workers and R2 but does not show Queues, KV, Hyperdrive, or Neon resources. A prototype deploys one stage with all of them. If it falls short, Pulumi with the Cloudflare provider and the community Neon provider takes over.
- Whether `drizzle-orm/effect-postgres` works through Hyperdrive on Workers with Neon. Its client calls `net.connect` and uses named prepared statements by default. T3 Code's relay runs this stack in production on PlanetScale Postgres with `prepare: false`, through Alchemy's `Drizzle.Postgres` helper. If it works on Neon, `packages/db` moves to it and auth stays on `pg`.
- Which embedding model to use. A bakeoff over the AI Gateway catalog scores a shortlist on a generated set of realistic queries with known answers, by recall at 10 and query latency. Embedding costs are small enough that quality and latency decide. Switching later means re-embedding, which costs a few dollars.
- Which model writes the summaries. The same query set compares candidates.
