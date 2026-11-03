# Search evals

This doc explains how Stargrep picks its embedding and summary models, and how to rerun the comparison. The query set is `evals/queries.json`. The script is `evals/bakeoff.ts`. The chosen models live in `packages/ai/src/models.ts`.

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

## Method

The corpus is the 238 expected repos. `bun run evals/bakeoff.ts corpus` fetches each repo's description, topics, language, and README through the GitHub GraphQL API, in 10 requests, and caches them in `evals/.cache/corpus.json`, which git ignores.

The bakeoff runs in two stages, so it scores every candidate without paying for every pair.

1. **Embedding models.** Summarize the corpus once with the current summary model. Embed each repo's text, which is its name, description, summary, and keywords, as production does. Then embed each query in its own call and rank the corpus by cosine similarity.
2. **Summary models.** Summarize the corpus with each summary candidate and score retrieval with the winning embedding model.

The script reports these columns for each model.

- **recall@10.** For each query, the share of its expected repos that appear in the top 10 results, averaged over all queries.
- **median ms.** For embedding models, the median time to embed one query. For summary models, the median time to summarize one repo.
- **cost.** Tokens counted by the `stargrep_ai_tokens` metric, priced from the public AI Gateway catalog.
- **failures.** Repos whose summary did not decode. The bakeoff embeds their description instead.

The winner is the model with the highest recall@10. A tie goes to the lower median latency. A gateway run writes the winners to `packages/ai/src/models.ts`.

Retrieval here is vector only. Production search also runs full-text search and merges both lists, so production recall should be equal or higher.

Every embedding candidate is asked for 1,024 dimensions. One size keeps the comparison fair and fixes the database column at `halfvec(1024)`. `Ai.embed` fails with `AiOutputInvalid` when a model returns another size.

## Candidates

Embedding models: `openai/text-embedding-3-small`, `openai/text-embedding-3-large`, `google/gemini-embedding-001`, `voyage/voyage-4-lite`, `voyage/voyage-4`, `cohere/embed-v5.0-fast`, and `alibaba/qwen3-embedding-8b`.

Summary models: `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, and `google/gemini-3.1-flash-lite`. These are the cheapest models in the catalog from three vendors that support structured output.

## Run it

```sh
GITHUB_TOKEN=... bun run evals/bakeoff.ts corpus
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts
bun run evals/bakeoff.ts --fake
```

`--fake` runs the whole pipeline on the fake `Ai` layer from `@stargrep/ai/fake`. It needs no key and never writes `models.ts`.

## Results

No gateway run exists yet, because the project has no AI Gateway key. Until one runs, `models.ts` holds `anthropic/claude-haiku-5.5` for summaries and `openai/text-embedding-3-small` at 1,024 dimensions for embeddings. These are defaults, not bakeoff winners. The recall bar for search, which `evals/recall.ts` enforces later, is set from the first gateway run.

The fake run on 2026-11-03 proves the pipeline end to end. Its recall comes from a hashed bag-of-words embedding, the same for every candidate, so it ranks no model. Its latency is in-process. Its cost column applies real catalog prices to estimated token counts, so it estimates what a gateway run will cost.

```
stage      model                            recall@10  median ms       cost failures
embedding  openai/text-embedding-3-small        0.659          0    $0.0009        0
embedding  openai/text-embedding-3-large        0.659          0    $0.0058        0
embedding  google/gemini-embedding-001          0.659          0    $0.0066        0
embedding  voyage/voyage-4-lite                 0.659          0    $0.0009        0
embedding  voyage/voyage-4                      0.659          0    $0.0027        0
embedding  cohere/embed-v5.0-fast               0.659          0    $0.0035        0
embedding  alibaba/qwen3-embedding-8b           0.659          0    $0.0004        0
summary    anthropic/claude-haiku-5.5           0.659          8    $0.0835        0
summary    openai/gpt-6-luna                    0.659          4    $0.0835        0
summary    google/gemini-3.1-flash-lite         0.659          4    $0.2188        0
```

A full gateway run should cost under $0.50.
