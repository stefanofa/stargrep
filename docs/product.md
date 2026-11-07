# Stargrep product

Stargrep searches a GitHub account's public stars in plain language. Enter a login and a query such as "Rust library for terminal dashboards". Public search works without signing in. Signing in with GitHub syncs your own stars using your token.

## Search

Keyword matches appear from the local library as you type. Server search adds matches by meaning after typing pauses. Results show repo metadata and summaries where available. Language, sort, tiles or list view, and the open repo can be shared in the URL.

The planner reads natural-language filters for language, license, project kind, archived state, starred dates, and metrics. Enrichment supplies star and fork totals. Growth and activity metrics have no rollup producer yet.

## Imports

Visiting an account in a visible browser tab asks for a sync if Stargrep does not know it. A signed-out import can wait for GitHub capacity. The page shows import and enrichment progress and lets the visitor retry a refused request. Server rendering alone never starts an import.

Repos, summaries, and embeddings are shared across accounts. Signing in claims your GitHub account and requests a sync. A weekly full read detects unstars when the owner's viewer call finds it due.

## API and MCP

One oRPC contract serves the web client, REST under `/api`, and MCP under `/mcp`. `/openapi.json` describes the public REST procedures. Public procedures are `search`, `triggerSync`, `syncStatus`, `getRepo`, `stars`, and `config`. `viewer` and `library` require a session cookie and stay out of the public OpenAPI document and MCP tools.

Search accepts only one account's stars as its scope. MCP currently exposes public tools without OAuth sign-in. API keys are not implemented.

## Data

Stargrep stores public accounts, repos, READMEs, and stars, plus generated summaries and embeddings. Better Auth stores sessions and encrypted GitHub tokens. User tokens stay on the server and are used only for work that user starts.

Search sends its query in an API POST body. Shared page links can contain `?q=`, so those URLs can appear in browser history and platform request logs. The app has no search-event writer.

## Planned features

Network and global search, follows, collections, taste profiles, digests, discovery pages, reranking, and private repos are not implemented. Schema tables and design mockups for some of these features are reserved for later work. Private repo data, when added, stays scoped to its user and never enters the shared repo index. Comments, likes, and direct messages are out of scope.
