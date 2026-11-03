# Starring architecture

This doc explains how Starring is built and why. `docs/product.md` explains what it does. Once code exists, the Drizzle schema and the oRPC contracts are the reference, and this doc only explains the decisions behind them.

## Principles

- **Headless core.** All domain logic lives in `packages/core` as plain functions. They take typed inputs and the ports they need (database, GitHub, AI) as arguments. Core has no imports from TanStack Start, Cloudflare, or oRPC. `bun test` runs it with fake ports and no network.
- **Parse at the boundary.** `packages/github` turns raw GitHub responses into domain types. `packages/api` validates requests with the contract schemas. Code inside trusts those types and does not validate again.
- **Shared repos, per-user stars.** Each repo is fetched, summarized, and embedded once, however many accounts starred it. An account's stars are rows that point at shared repos.
- **GitHub numeric IDs as keys.** Accounts and repos are keyed by GitHub's numeric IDs. Logins and repo names change on rename.
- **Idempotent pipeline steps.** Every ingestion step converges to the same state when it runs twice. Queues retry, so steps must survive retries.

## Stack

Versions were checked on 2026-11-03. Pin exact versions in `package.json`.

| Concern | Choice |
|---|---|
| Monorepo | Turborepo 2.11 |
| Package manager, scripts, tests | Bun 1.4 and `bun test` |
| App framework | TanStack Start 1.169 |
| Client data | TanStack DB 1.0 RC |
| API, REST, MCP | oRPC 2.0 beta, with `@orpc/openapi` and `@orpc/mcp` |
| AI | Vercel AI SDK 7 |
| Auth | Better Auth 1.7, GitHub sign-in through a GitHub App, `@better-auth/oauth-provider` for MCP |
| Database | Neon Postgres with pgvector, Drizzle ORM |
| Runtime | Cloudflare Workers, Hyperdrive in front of Neon |
| Jobs | Cloudflare Queues, Workflows, and cron triggers |
| Blob storage | Cloudflare R2 |
| Cache | Cloudflare KV and the Workers cache |
| UI | shadcn components on Base UI |
| Lint and format | Biome |

Production code runs on the Workers runtime, not Bun. Code in `apps/` and every package they import must avoid Bun-only APIs. Bun runs installs, scripts, and tests.

oRPC 2.0 is a beta. Pin one beta version and upgrade on purpose.

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
  config/           shared tsconfig and Biome config
```

Each feature folder in `core` holds its types, functions, and tests together. File names are kebab-case. A file is named after what it exports, such as `parse-query.ts` for `parseQuery`.

## Data model

Better Auth owns `user`, `session`, and `account`. Starring adds these tables.

| Table | Key | Holds |
|---|---|---|
| `github_accounts` | GitHub user ID | login, name, avatar, follower count, `claimed_by` user, star sync state and ETag |
| `repos` | GitHub repo ID | owner, name, description, topics, language, counts, `pushed_at`, archived, README object ID, summary, keywords, `embedding halfvec(1024)`, embedding model, full-text column |
| `stars` | account ID and repo ID | `starred_at`, `unstarred_at`, source (`gharchive` or `api`) |
| `follows` | follower ID and followee ID | source (`github` or `starring`), created time |
| `collections` | ID | owner, slug, title, description, kind (`user` or `editorial`) |
| `collection_items` | collection ID and repo ID | note, position |
| `repo_snapshots` | repo ID and day | stars, forks, open issues, latest release |
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

`packages/github` sends requests one after another per token, as GitHub's best practices ask. This keeps it under the secondary limit of 100 concurrent requests.

## Ingestion pipeline

Each step is a queue message type. Each consumer is idempotent.

1. `sync-stars` fetches an account's star list newest first and stops at the first star it already has. A full sync runs on claim and weekly after that. Stars that are gone mark `unstarred_at`.
2. `enrich-repo` runs for repos that are new or whose README object ID changed. It stores the README in R2, writes the summary and keywords, and computes the embedding.
3. `snapshot-repos` is a daily cron that records counts for repos that are starred in Starring.
4. `import-gharchive` is an hourly cron that loads new star events.

Bulk enrichment, such as a backfill of popular repos, uses the model provider's batch API.

## Search

Every search is hybrid. Full-text search and vector search run in one SQL query, and reciprocal rank fusion merges the two lists.

- **Your stars.** The candidate set is one account's stars, at most tens of thousands of rows. An exact vector scan over that set takes milliseconds, so this path uses no vector index.
- **Network.** The candidate set is the union of the stars of the accounts you follow. Results also rank by how many of those accounts starred each repo.
- **Global.** An HNSW index on `repos.embedding`. Filtered queries use pgvector's iterative index scans.

The query parser calls a small model for structured output and returns filters and the text to embed. KV caches parsed queries and query embeddings by normalized query text.

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
| Workers cache | Public profile pages, SEO pages, and OG images, with stale-while-revalidate |
| KV | Parsed queries and query embeddings |
| Postgres | Summaries and embeddings, shared across accounts |
| GitHub | ETags, so unchanged lists return `304` |

## Testing

- `packages/core` tests use `bun test` with fake ports. They cover behavior, such as "an unstarred repo gets `unstarred_at`", not internal calls.
- `packages/db` and the pipeline run integration tests against a Neon branch made for each test run.
- `apps/web` and `apps/worker` need tests that run on the Workers runtime. `bun test` does not emulate it. Settle the runner with a prototype in phase 0.

## Open technical questions

- How many star events GH Archive holds in total. One BigQuery count decides whether history lives in Postgres or in ClickHouse.
- Whether TanStack Start, Hyperdrive, and Neon work together on Workers without friction. A phase 0 prototype settles it.
- Whether `@orpc/mcp` covers OAuth for MCP clients, or Better Auth's OAuth provider plugin has to wrap it.
- Which embedding model to use. Compare two or three on 20 real queries before the backfill.
