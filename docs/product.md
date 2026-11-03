# Stargrep product spec

Stargrep is a website for searching GitHub stars in plain language. You type "the Rust library for terminal dashboards I starred last year" and get the repos that match. It works for any public GitHub username without signing in. Signing in with GitHub adds a fresh sync, a social graph, and collections.

## Who it is for

- **Developers with many stars.** They star repos to find them later, and GitHub's star search only matches names and descriptions.
- **Developers choosing a tool.** "What do people I follow use for auth in Next.js?" has no good answer on GitHub today.
- **Coding agents.** An agent in an editor can ask the MCP server which library the user starred for a job.

## Experience principles

These rules apply to every screen and every feature decision.

- **Fast enough to feel local.** Keyword results appear on each keystroke. Semantic results merge in after, without moving what the user is reading.
- **Show only what helps the next decision.** A result shows why it matched, how alive the repo is, and who in your network starred it. Everything else waits behind a click.
- **Crafted, not busy.** A small number of features, each finished in detail, with real empty, loading, syncing, and error states.
- **No login wall.** Every public page works signed out. Sign-in earns its place by adding something.

## Features

### Search your stars

- One search box accepts names, keywords, and natural language.
- The query parser extracts filters from the text: language, starred date, star count, archived or alive. Filters show as removable chips.
- Each result shows the summary line that explains the match.
- Results load from the user's local library first, then the server merges semantic results.
- "Deep search" reranks the top results with an LLM. It is opt-in because it adds about a second.

### Ask with real criteria

Search understands more than topics. It filters and ranks by what repos and their owners do.

- "Open source apps like Wispr Flow with the most contributors."
- "TypeScript ORMs where commits grew in the last 90 days."
- "CLI tools from orgs with more than 10k followers, still maintained."

Criteria include license, kind of project (app, library, CLI, and so on), stars, forks, commits, active and new contributors, merged pull requests, releases, and the owner's followers and total stars. Each criterion works as a current value or as a change over 30 or 90 days. Results show the numbers that ranked them.

### Profiles for any username

- `/{username}` shows that account's stars, searchable, plus their taste profile.
- Profiles exist for accounts nobody has claimed yet, built from public data.
- An unclaimed profile shows "Is this you? Sign in to claim it." Claiming unlocks sync with the owner's token, collections, and profile settings.

### Social

- **Follows import.** Sign-in imports the user's GitHub follows, so the graph exists on day one.
- **Network search.** Search across the stars of everyone you follow. Results rank by match and by how many of them starred each repo, and show "starred by 4 people you follow".
- **Weekly digest.** What your network starred this week, grouped by topic. It is opt-in by email.
- **Collections.** Public lists with a note on each repo, such as "my Rust TUI stack".
- **Taste profile.** Languages, topics, and starring history as a shareable card.
- **Similar taste.** Accounts whose stars overlap with yours.

Comments, likes, and direct messages are out of scope. They need moderation and add little to search.

### Discovery pages

- "Best X" pages, such as "best Rust TUI libraries", ranked from star data and collections.
- Yearly pages, such as "best TypeScript libraries of 2027".
- "Alternatives to X" pages, built from co-star data. People who star X also star Y.
- Topic pages and trending pages.

### API and MCP

- One API serves the web app, a public REST API with an OpenAPI spec, and MCP tools.
- MCP tools include `search_stars`, `search_network`, `find_alternatives`, `get_repo`, and `trending`.
- MCP clients connect over OAuth. Scripts use API keys.

### Planned

- Stars on private repos. Private repo data stays scoped to its user and never enters the shared repo index.

## Sponsored results

Stargrep shows sponsored placements. These rules hold for every one.

- Every sponsored item has a visible label.
- Placement depends on the page or the query, never on tracking the viewer.
- API and MCP results never contain sponsored items.

## Data and privacy

Stargrep stores public GitHub data: accounts, repos, READMEs, stars, and follows. It also stores what it derives from that data, such as repo summaries, embeddings, and daily repo counts.

- Search queries are stored without the identity of the person who searched.
- Stargrep never sells data about an individual account.
- Stargrep never emails anyone who has not signed up.
- Private repo data is visible only to the user who can access it.
