# Search evals

This doc explains how Stargrep picks its embedding and summary models, what the comparison found, and the recall bar search must meet. The query set is `evals/queries.json`. The script is `evals/bakeoff.ts`. The chosen models live in `packages/ai/src/models.ts`.

## Query set

`evals/queries.json` holds 129 queries. Each query lists the public repos a developer would expect to find for it, 1.9 repos on average and 238 distinct repos in total.

| Category | Queries | Example |
|---|---|---|
| product | 28 | "open source apps like Wispr Flow" |
| library | 29 | "rust library for terminal dashboards" |
| cli | 20 | "terminal ui for git" |
| app | 18 | "self-hosted git service" |
| framework | 14 | "elixir web framework" |
| task | 6 | "block ads for every device on my network" |
| non-english | 5 | "selbst gehostete Fotoverwaltung" |
| list, learning, model, config | 9 | "learn system design for interviews" |

Product queries name a product that has no repo of its own, so only a model that knows what the product does can match them. Non-English queries check that English summaries still match queries in other languages.

Every expected repo was checked against the GitHub API on 2026-11-03. Names are the current `owner/name` that GitHub returns after renames. `bun run evals/bakeoff.ts corpus` repeats the check and fails with a list of any repo that is missing or renamed.

## Corpus

The corpus is the 238 expected repos plus the 498 repos in `evals/distractors.json`, 736 in all. The distractors are the most-starred repos on GitHub on 2026-11-03, minus the expected ones. They stand in for the rest of a developer's star list. Without them every model scored between 0.982 and 0.995, so the eval could not tell models apart.

`bun run evals/bakeoff.ts corpus` fetches each repo's description, topics, language, and README through the GitHub GraphQL API, in 30 requests, and caches them in `evals/.cache/corpus.json`, which git ignores.

## Method

The bakeoff runs in two stages, so it scores every candidate without paying for every pair.

1. **Embedding models.** Summarize the corpus once with the summary model in `models.ts`. Embed each repo's text, which is its name, description, summary, and keywords, as production does. Then embed each query in its own call and rank the corpus by cosine similarity.
2. **Summary models.** Summarize the corpus with each summary candidate and score retrieval with the winning embedding model.

The script reports these columns for each model.

- **recall@10.** For each query, the share of its expected repos in the top 10 results, averaged over all queries. One query is worth 1/129, about 0.008.
- **median ms.** For embedding models, the median time to embed one query from a laptop in Europe. For summary models, the median time to summarize one repo.
- **cost.** Tokens counted by the `stargrep_ai_tokens` metric, priced from the public AI Gateway catalog.
- **failures.** Repos whose summary did not decode. The bakeoff embeds their description instead.

Retrieval here is vector only. Production search also runs full-text search and merges both lists.

Two runs of the same setup differ by up to 0.009 for one model, about one query. So the winner rule treats every model within 1/129 of the best recall as tied. Ties go to the lowest median query latency for embedding models, because query embedding is on the search path. Ties go to the lowest cost for summary models, because summaries run in the background. Transient gateway errors are retried up to three times.

Every embedding candidate is asked for 1,024 dimensions. One size keeps the comparison fair and fixes the database column at `halfvec(1024)`.

## Candidates

Embedding models: `openai/text-embedding-3-small`, `openai/text-embedding-3-large`, `google/gemini-embedding-001`, `voyage/voyage-4-lite`, `voyage/voyage-4`, `cohere/embed-v5.0-fast`, and `alibaba/qwen3-embedding-8b`.

Summary models: `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, and `google/gemini-3.1-flash-lite`. These are the cheapest models in the catalog from three vendors that support structured output.

## Results

The final run on 2026-11-03 used the gateway, 129 queries, and 736 repos.

```
stage      model                            recall@10  median ms       cost failures
embedding  openai/text-embedding-3-small        0.959        500    $0.0023        0
embedding  openai/text-embedding-3-large        0.975        503    $0.0149        0
embedding  google/gemini-embedding-001          0.990        969    $0.0170        0
embedding  voyage/voyage-4-lite                 0.979        382    $0.0022        0
embedding  voyage/voyage-4                      0.988        352    $0.0067        0
embedding  cohere/embed-v5.0-fast               0.977        291    $0.0094        0
embedding  alibaba/qwen3-embedding-8b           0.965       3608    $0.0011        0
summary    anthropic/claude-haiku-5.5           0.988       2138    $0.5573        0
summary    openai/gpt-6-luna                    0.990       3676    $0.3918        0
summary    google/gemini-3.1-flash-lite         0.986       1281    $0.9641        0
Embedding ranking: voyage/voyage-4 > google/gemini-embedding-001 > cohere/embed-v5.0-fast > voyage/voyage-4-lite > openai/text-embedding-3-small > openai/text-embedding-3-large > alibaba/qwen3-embedding-8b
Summary ranking: openai/gpt-6-luna > anthropic/claude-haiku-5.5 > google/gemini-3.1-flash-lite
Chosen: summary openai/gpt-6-luna, embedding voyage/voyage-4 at 1024 dimensions
```

**Embeddings: `voyage/voyage-4` at 1,024 dimensions.** It ties `google/gemini-embedding-001` on recall, 0.002 behind, which is less than one query. It embeds a query in a median 352 ms against 969 ms, and it costs $0.06 per million tokens against $0.15. The run before it ranked the same winner, with `voyage/voyage-4-lite` second at 0.983. `voyage-4-lite` fell to 0.979 here and left the tie, so second place is not stable. First place is.

**Summaries: `openai/gpt-6-luna`.** All three candidates are within 0.004, half a query, in both runs. `gpt-6-luna` is the cheapest at catalog prices, $0.39 for 736 repos or about $0.53 per 1,000, and no summary failed to decode. It is the slowest, at a median 3.7 s, which does not matter for background enrichment.

Query latency here is measured from a laptop. The plan's perf lane measures it again from a Worker against a 250 ms median.

## Recall bar

Search must reach **recall@10 of 0.97** on this query set over this 736-repo corpus, loaded as one account's stars and enriched by the production pipeline. `evals/recall.ts` enforces it.

The chosen pair measured 0.988 and 0.990 with vector search alone. Hybrid search should not score lower. Run-to-run noise is about one query, 0.008. The bar is the measured recall minus two queries of noise, rounded down to 0.97. A result below it means search lost at least two queries' worth of results, which is a real regression and not noise.

## Spend

The AI Gateway ledger shows $1.10 for every run on 2026-11-03: a 10-query smoke run, two full runs, one run that a gateway error stopped after its first stage, and the live checks. The script's own price estimate for the same work is about four times higher. The ledger is the bill.

## Run it

```sh
GITHUB_TOKEN=... bun run evals/bakeoff.ts corpus
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts --limit 10
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts
bun run evals/bakeoff.ts --fake
```

`--limit N` scores only the first N queries against their own expected repos, without distractors, as a cheap smoke test. `--fake` runs the whole pipeline on the fake layers from `@stargrep/ai/fake` and needs no key. A full gateway run writes the winners to `packages/ai/src/models.ts`. A `--limit` or `--fake` run never does.

To compare summary samples locally without the gateway, run `evals/summarize.ts` through the Claude Code CLI, as `docs/architecture.md` describes under "AI providers".

```sh
STARGREP_MODE=local AI_TEXT_PROVIDER=claude-code AI_EMBEDDINGS_PROVIDER=fake bun run evals/summarize.ts ratatui/ratatui
```
