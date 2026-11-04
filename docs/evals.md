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

Every expected repo was checked against the GitHub API on 2026-11-03. Names are the current `owner/name` that GitHub returns after renames. `bun run evals/corpus.ts` repeats the check and fails with a list of any repo that is missing or renamed.

## Corpus

The corpus is the 238 expected repos plus the 498 repos in `evals/distractors.json`, 736 in all. The distractors are the most-starred repos on GitHub on 2026-11-03, minus the expected ones. They stand in for the rest of a developer's star list. Without them every model scored between 0.982 and 0.995, so the eval could not tell models apart.

`bun run evals/corpus.ts` fetches each repo's description, topics, language, and README through the GitHub GraphQL API, in 30 requests, and caches them in `evals/.cache/corpus.json`, which git ignores.

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

The winner rule differs by port, in `evals/rank.ts`.

- **Embedding models must fit a latency budget, then win on recall.** Query embedding is on the search path. The plan's budget is a 250 ms median from a Worker, which the perf lane measures. The bakeoff runs on a laptop, which adds network distance to every model, so it screens with the plan's 600 ms p95 ceiling applied to the laptop median. Models over it are dropped before ranking, and the rest are ordered by recall.
- **Summary models win on recall, with ties broken by cost.** Two runs of the same setup differ by up to 0.009 for one model, about one query, so models within 1/129 of the best recall are tied. Summaries run in the background, so the cheapest tied model wins.

Transient gateway errors are retried up to three times.

Every embedding candidate is asked for 1,024 dimensions. One size keeps the comparison fair and fixes the database column at `halfvec(1024)`.

## Candidates

Embedding models: `openai/text-embedding-3-small`, `openai/text-embedding-3-large`, `google/gemini-embedding-001`, `voyage/voyage-4-lite`, `voyage/voyage-4`, `cohere/embed-v5.0-fast`, and `alibaba/qwen3-embedding-8b`.

Summary models: `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, and `google/gemini-3.1-flash-lite`. These are the cheapest models in the catalog from three vendors that support structured output.

## Results

The final gateway run on 2026-11-03, run 3, used 129 queries and 736 repos. This is its output as printed, under the ranking rule it ran with, which "History" below explains.

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

**Embeddings: `voyage/voyage-4` at 1,024 dimensions.** `google/gemini-embedding-001` has the highest recall in both full runs, 0.990, but its median query takes 954 ms and 969 ms. That fails the plan's embedding latency budget by any reading, so it cannot serve the search path. Among the models inside the budget, `voyage/voyage-4` has the highest recall in both runs, 0.986 and 0.988, with `voyage/voyage-4-lite` second both times. It costs $0.06 per million tokens. Its 352 ms median was measured from the laptop. Whether it meets the 250 ms budget from a Worker is still open, and the perf lane on the deployed stage answers it.

**Summaries: `openai/gpt-6-luna`.** All three candidates are within 0.004, half a query, in both runs. `gpt-6-luna` is the cheapest at catalog prices, $0.39 for 736 repos or about $0.53 per 1,000, and no summary failed to decode. It is the slowest, at a median 3.7 s, which does not matter for background enrichment.

### History

The ranking rule changed during the work, and the record above shows it.

1. Run 2 ranked by recall alone. Its winner for embeddings was `google/gemini-embedding-001` at 0.990, ahead of `voyage/voyage-4` at 0.986.
2. After run 2, a tie rule was added: models within one query of the best were tied, and ties went to the lowest latency. Run 3 ran with it and printed `voyage/voyage-4` first. That rule had a bug. It also sorted models outside the tie by latency instead of recall, which is why the embedding ranking printed above puts `cohere/embed-v5.0-fast` third.
3. The current rule replaces the latency tie-break for embeddings with the explicit latency budget. `evals/rank.test.ts` applies it to the recorded numbers of runs 2 and 3, and both rank `voyage/voyage-4` first and `voyage/voyage-4-lite` second.

The choice of `voyage/voyage-4` does not depend on the tie rule. It follows from two facts that hold in both runs: Gemini is over the latency budget, and Voyage 4 has the best recall of the models under it.

### Model changes

**2026-11-04. Summaries move to `anthropic/claude-haiku-5.5`.** The tie rule above puts all three summary models level on recall. In run 3, `claude-haiku-5.5` scored 0.988 and `gpt-6-luna` scored 0.990, which is within one query. The bakeoff broke the tie by cost and picked `gpt-6-luna`. Repo enrichment then measured what the bakeoff did not. A 2-request AI Gateway batch on `claude-haiku-5.5` finished in 3.7 minutes, while a 200-request `gpt-6-luna` batch sat at 0 of 200 for more than 79 minutes. Single summaries are faster on Haiku too, a 2.1 s median against 3.7 s in run 3. Single and batch summaries both use `claude-haiku-5.5`, so every stored summary comes from one model. At catalog prices it costs about $0.76 per 1,000 repos against $0.53. `evals/rank.ts` still breaks summary ties by cost, so a new bakeoff run prints `gpt-6-luna` on its `Chosen:` line.

## Recall bar

Search must reach **recall@10 of 0.97** on this query set over this 736-repo corpus, loaded as one account's stars and enriched by the production pipeline. P8 adds `evals/recall.ts`, which enforces it in CI.

The chosen pair measured 0.988 and 0.990 with vector search alone. Hybrid search should not score lower. Run-to-run noise is about one query, 0.008. The bar is the measured recall minus two queries of noise, rounded down to 0.97. A result below it means search lost at least two queries' worth of results, which is a real regression and not noise.

## Spend

The AI Gateway ledger shows $1.10 for every run on 2026-11-03: a 10-query smoke run, two full runs, one run that a gateway error stopped after its first stage, and the live checks. The script's own price estimate for the same work is about four times higher. The ledger is the bill.

## Run it

```sh
GITHUB_TOKEN=... bun run evals/corpus.ts
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts --limit 10
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts
bun run evals/bakeoff.ts --fake
```

`--limit N` scores only the first N queries against their own expected repos, without distractors, as a cheap smoke test. `--summary <model>` scores one summary model on the full corpus through one AI Gateway batch job, using the embedding model in `models.ts`. `--fake` runs the whole pipeline on the fake layers from `@stargrep/ai/fake` and needs no key. No run edits code. To adopt a result, copy the models from the `Chosen:` line into `packages/ai/src/models.ts` by hand.

To compare summary samples locally without the gateway, run `evals/summarize.ts` through the Claude Code CLI, as `docs/architecture.md` describes under "AI providers".

```sh
STARGREP_MODE=local AI_TEXT_PROVIDER=claude-code AI_EMBEDDINGS_PROVIDER=fake bun run evals/summarize.ts ratatui/ratatui
```
