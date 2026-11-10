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

Two smaller sets check what recall@10 cannot. `evals/typos.json` holds 16 misspelled names and descriptions, such as "zustnad" for `pmndrs/zustand` and "fuzy finder" for `junegunn/fzf`, each with the repo it means. `evals/nonsense.json` holds 38 queries no repo answers: gibberish, keyboard mashes, unrelated words such as "wedding dress shopping", and nonsense or unrelated phrases in other languages. Search must find every typo's repo and answer every nonsense query with nothing. Neither set counts toward recall@10.

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

The AI SDK retries transient model requests up to three times within the port timeout, except the planner, which does not retry. The Gateway batch adapter retries batch API requests itself. Callers do not add another model retry loop.

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

The full recall run must reach **recall@10 of 0.97** on this query set over the 736-repo corpus, loaded as one account's stars and enriched by the production pipeline. `evals/recall.ts` enforces that bar. CI runs a smaller recorded fixture and requires its recorded score, described below.

The chosen pair measured 0.988 and 0.990 with vector search alone. Hybrid search should not score lower. Run-to-run noise is about one query, 0.008. The bar is the measured recall minus two queries of noise, rounded down to 0.97. A result below it means search lost at least two queries' worth of results, which is a real regression and not noise.

## Search recall

`evals/recall.ts` runs the query set through real search. It summarizes the corpus with the summary model and embeds each repo's text, as enrichment does. It saves each answer's facts as a receipt and projects them into atoms, as enrichment does. It loads all 736 repos as the stars of one account, `recall-eval`, in a Postgres database named `stargrep_recall`. Then it sends each query through the `Search` service in `packages/core`, which calls the planner, embeds the query, and runs `search.hybrid`. It exits with an error when recall@10 is under the bar.

Summaries, vectors, plans, and query embeddings are cached in `evals/.cache`, which git ignores. A rerun makes no model call unless the corpus, a model, or the planner prompt changes.

### Results

The run on 2026-11-04 used `anthropic/claude-haiku-5.5` for summaries and the planner and `voyage/voyage-4` for embeddings. Plans vary from run to run, so three independent sets of plans were scored. They reached 0.987, 0.991, and 0.991. Three queries took the keyword path and 126 went to the planner. All three missed these repos, and the first also missed `run-llama/llama_index`, which ranks at the edge of the top 10.

- `EpicenterHQ/epicenter` for "open source apps like Wispr Flow". Before the kind rule, the plan's `app` filter left it out, because the summarizer calls it a framework. Without that filter it still ranks below 40th, because its summary describes a local-first sync framework and never mentions dictation.
- `ollama/ollama` for "run large language models locally", which ranks just outside the top 10.
- `d3/d3` for "javascript charting library". GitHub labels d3 as Shell and gives it no `javascript` topic, so the stated language filter leaves it out.

The first run reached 0.933. These changes got it over the bar. Each row except the prompt changes was scored on the same cached plans, so only the named change moved.

| Change | recall@10 |
|---|---|
| First run: filters as the model chose them, full text on keywords the model chose | 0.933 |
| A language filter also matches the repo's topics | 0.951 |
| Kind filters the model inferred are ignored | 0.973 |
| License filters the model inferred are ignored | 0.981 |
| Full text on the words the user typed instead of model keywords | 0.990 |
| The prompt forbids inferred kinds and licenses and shows five examples, with new plans | 0.978 |
| A JavaScript filter also matches TypeScript | 0.994 |
| Code drops kind filters the query does not restrict and languages it does not name, with new plans | 0.994 |
| Two plain words at most skip the planner, so 3 queries take the keyword path instead of 31, with new plans | 0.988 |
| A language filter needs a real language, so "React" is dropped | 0.991 |
| The model quotes the words that named each language, and code keeps a language only when they appear in the query, with new plans | 0.987 to 0.991 |

Two baselines frame these numbers. The raw query with no planner reaches 0.988 with hybrid search and 0.990 with vector search alone. The planner still earns its place. On product queries the raw query reaches 0.964, because "like Wispr Flow" names a product that no repo describes. Full text on model keywords cost 0.009, and dropping full text for planned queries entirely reached 0.997, one query above typed words. Search keeps full text on the typed words, so every search stays hybrid.

### Atoms

On 2026-11-09, with recipe 2 summaries and the cached plans, search with atom filters and boosts reached 0.992, against 0.990 on the same cache before. Kind, language, and license filters read atoms, and the summary model's language claims now reach a language filter, so `d3/d3` is found for "javascript charting library", which GitHub labels Shell. No subject is accepted until curation accepts one, so stated subject words still compiled to nothing in that run. Two runs on the same cache measured what happens once they resolve. `--accept-floor` runs the usage floor, which accepts every subject that 3 repos from 2 owners hold, 405 of 2,506.

| Run | recall@10 |
|---|---|
| Atoms, no subject accepted | 0.992 |
| Subjects accepted at the floor, with the shipped policy | 0.992 |
| Subjects accepted at the floor, bare subjects as filters (`--bare-filters`) | 0.946 |

Bare subjects therefore boost. As filters they dropped Alacritty, Ghostty, and kitty for "gpu accelerated terminal emulator", Caddy for "reverse proxy with automatic https", and the repos of 8 other queries. A first version of the compiler let a relation cue reach past a kind or platform word, so "framework for building LLM apps and agents" filtered on "agents" and lost LangChain, and it scored 0.973 with subjects accepted. A relation clause that a closed word cuts short now boosts.

### Judged queries

None of the 129 recall queries has a negation, a contraction, "only", or "with" before a feature, so recall cannot see those paths. `evals/behavior.ts` lists 39 judged queries for negation, contractions, "only", built with, built on, powered by, with, for, kinds, languages, and platforms, among them "no dependency cli tool", "apps that never run on windows", "cli tools built with rust", "apps built on node", "typescript orm, not javascript", "llm apps with privacy", and "only libraries for building apps". `evals/behavior.test.ts` runs each one through `Search` on the 78 recorded repos in `evals/fixtures/behavior-repos.jsonl`, with a guarded plan written into the case and a named repo's recorded vector standing in for the query's, so it makes no model call. It compares the search with atoms to the same search with every policy row off. It checks that the repos the case keeps are in both, that the repos it drops were there before and are gone after, and that a query the search without atoms answers with more than 5 repos never answers with none. It runs four times: with no subject accepted and after the usage floor, each through SQL alone and through the accepted-key cache the web server keeps. A few repos are in the fixture only because they hold privacy, GitHub, or AI, so the floor accepts those subjects there as it does on the whole corpus. Against the round 3 compiler, 24 of its 156 runs fail. `bun run evals/recall.ts --write-behavior` rewrites the fixture from the cache.

### Meaning floor

On 2026-11-05 the query "dfsfgdsrg" found 20 of an account's 1,780 stars. The eval corpus shows the same thing. There the query returns 20 results, each a meaning match and none a word or name match. Full text needs the query's words in the repo, and a name match needs the exact name, but the vector side always returns the nearest repos however far they are. Rank fusion scores by rank alone, so the nearest repo to gibberish scored like the nearest repo to a real query.

The vector side now keeps only repos within the embedding model's `maxMatchDistance`, a cosine distance from the query. Cosine distances on this corpus set its value.

| Query | Distance to the best repo |
|---|---|
| The 126 planned eval queries | 0.093 to 0.327 |
| The 3 keyword eval queries, as typed | 0.366 to 0.449 |
| Nonsense, as typed | 0.484 to 0.768 |
| Nonsense, as the planner rewrote it | 0.406 to 0.696 |
| Typos, as typed, to the repo they mean | 0.355 to 0.688 |
| Typos, as the planner rewrote them, to the repo they mean | 0.097 to 0.308 |

No max distance on the typed text keeps typos and drops nonsense, because "zustnad" sits at 0.639 from Zustand and "dfsfgdsrg" at 0.540 from its nearest repo. A cutoff relative to the query's own distances fails too. The best repo for a nonsense query stands 2.7 to 4.8 standard deviations above the query's mean distance, and real matches start at 2.6. The planner's rewrites separate them, so a keyword query that matches nothing gets planned and searched again.

`bun run evals/recall.ts --max-distances` scored these values on the same cached plans and vectors. A max distance of 2 keeps every repo, as search did before.

```
max distance  recall@10  typos found  nonsense answered
        2.00      0.991        16/16              38/38
        0.50      0.991        15/16              17/38
        0.45      0.991        16/16               5/38
        0.42      0.991        16/16               1/38
        0.40      0.991        16/16               0/38
        0.38      0.991        16/16               0/38
        0.36      0.991        16/16               0/38
        0.34      0.991        16/16               0/38
        0.32      0.991        16/16               0/38
        0.30      0.990        15/16               0/38
        0.28      0.972        14/16               0/38
```

Every max distance from 0.32 to 0.40 keeps recall, finds every typo, and answers no nonsense. Search uses 0.36, the middle, which leaves 0.04 before the first loss on either side. At 0.30, "neovm" and one eval query lose a repo. At 0.42, the planner's reading of "plumber" matches `pathwaycom/pathway`. At 0.50, "typsense" finds a near repo as typed, so it is never planned and misses `typesense/typesense`.

The range that works is narrow, from 0.32 to 0.40, and the same 54 typo and nonsense queries both chose the value and test it. No held-out set checks it. Two risks are known and unmeasured.

- **Larger accounts.** A nonsense query's nearest repo gets closer as an account stars more repos. A fit of nearest distance against the log of the star count, over subsamples of this corpus, projects that 2 of the 23 planner rewrites of short gibberish come within 0.36 at 5,000 stars, and 9 at 20,000. Such an account could get 1 to 3 results for gibberish again, not 20. This is an extrapolation, not a measurement.
- **Obscure typos.** All 16 typos name projects the planner knows, such as Zustand and ripgrep. A typo of a star the planner cannot identify likely finds nothing now. Before, the typed vector often ranked it first. A follow-up adds typos of niche repos and a check on a larger corpus.

The value belongs to the embedding model. After a model change, rerun the sweep and set the new model's `maxMatchDistance` to the middle of its plateau.

### In CI

CI runs `bun run evals/recall.ts --fixture`. The fixture is three files in `evals/fixtures`, one entry per line, so a rewrite shows as a readable diff.

- `recall.json` names 16 queries and the recall the fixture scored on the 11 from `queries.json` when it was written, 0.970. They are the first query of each category in each set: 11 from `queries.json`, all planned, the first typo, and the first nonsense query of each of the 4 kinds.
- `recall-repos.jsonl` holds 52 repos: the expected repos and the three highest-ranked wrong results for each query in the last full run. Each repo has its public metadata, summary, keywords, the facts the summary model stated with their quotes, and vector, and no README text. So the fixture checks the query compiler and atom filters against real claims.
- `recall-answers.jsonl` holds every cached plan and query embedding those searches read, under the cache namespace that names the model and the prompt version. A typo or nonsense query typed as a keyword reads two embeddings and one plan.

The fixture run loads PGlite in the test process and fails any model or embedding call, so it needs no key and no Postgres. It fails when recall drops under the recorded recall, when the typo misses its repo, or when a nonsense query gets a result. It also fails when a query is missing from the cache, which happens after a change to the planner prompt or a model. After such a change, run `--write-fixture` with a key and commit the new fixture.

A fixture of real vectors and plans tests the ranking that production runs. A run on hash embeddings would only test the plumbing.

## Spend

Calibrating the meaning floor on 2026-11-05 used 222,107 input and 10,365 output tokens of `anthropic/claude-haiku-5.5` for plans and 1,286 tokens of `voyage/voyage-4`, about $0.03 at catalog prices. Every other plan and vector came from the cache.

The AI Gateway ledger shows $1.10 for every run on 2026-11-03: a 10-query smoke run, two full runs, one run that a gateway error stopped after its first stage, and the live checks. The script's own price estimate for the same work is about four times higher. The ledger is the bill.

## Run it

```sh
GITHUB_TOKEN=... bun run evals/corpus.ts
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts --limit 10
AI_GATEWAY_API_KEY=... bun run evals/bakeoff.ts
bun run evals/bakeoff.ts --fake
```

`--limit N` scores only the first N queries against their own expected repos, without distractors, as a cheap smoke test. `--summary <model>` scores one summary model on the full corpus through one AI Gateway batch job, using the embedding model in `models.ts`. `--fake` runs the whole pipeline on the fake layers from `@stargrep/ai/fake` and needs no key. No run edits code. To adopt a result, update `packages/ai/src/models.ts`. A summary model, prompt, or schema change also requires a new summary recipe and its migration. An embedding model change requires the database migration and re-embedding described in `docs/architecture.md`. Regenerate the recall fixture after planner or model changes.

The recall gate needs Postgres, from `docker compose up --detach --wait` or a `DATABASE_URL` on that server. Each run drops `stargrep_recall` from the server's `postgres` database and creates and migrates it again, so no earlier corpus or accepted subject carries over, and `DATABASE_URL` may name `stargrep_recall` itself.

```sh
AI_GATEWAY_API_KEY=... bun run evals/recall.ts
AI_GATEWAY_API_KEY=... bun run evals/recall.ts --write-fixture
AI_GATEWAY_API_KEY=... bun run evals/recall.ts --max-distances 0.32,0.36,0.40
bun run evals/recall.ts --fixture
```

`--max-distances` scores search at each listed value of `maxMatchDistance` and prints one line per value. `--accept-floor` runs the usage floor before the queries run, which accepts every subject held by 3 repos from 2 owners, and `--bare-filters` adds bare subjects as filters, so a change to the compiler's policy can be measured before it ships.

`--summary-model ID` summarizes with another model. A full run from an empty cache used 4.96 million input and 0.19 million output tokens of `anthropic/claude-haiku-5.5` and 0.11 million tokens of `voyage/voyage-4`, about $0.60 at catalog prices. A rerun with a new planner prompt costs about 0.44 million input tokens, for 126 plans.

To compare summary samples locally without the gateway, run `evals/summarize.ts` through the Claude Code CLI, as `docs/architecture.md` describes under "AI providers".

```sh
STARGREP_MODE=local AI_TEXT_PROVIDER=claude-code AI_EMBEDDINGS_PROVIDER=fake bun run evals/summarize.ts ratatui/ratatui
```
