# Repo knowledge

Stargrep keeps what it knows about a repo as a set of small typed facts. Search filters, topic pages, digests, and the API all read those facts the same way. This page explains the six ideas the model rests on and the registries in `packages/knowledge` that define its closed parts.

`packages/knowledge` is a leaf package that depends only on `effect`. It holds the registries, the atom and selection codecs, `labelKey`, `evidenceText`, `extractionLines`, the input hash, the facets decoder, the curation fold, and the projection. `packages/ai`, `packages/db`, and `packages/core` import it. A cron projects every repo from its receipt and its GitHub facts. The summary call extracts facets, and every answer is kept as a receipt. Repos summarized before that have legacy receipts, made from their old summaries. Curation writes decisions through an operator CLI, two seed batches, and a nightly rule.

## Six primitives

1. **Facet.** A value a repo can be filtered on. Each facet belongs to one dimension. Kind, language, license, platform, and status are closed lists in code. Subject is open. A subject is any concept seen in the wild, such as TUI, PostgreSQL, or Slack, stored in the database with a permanent numeric ID.
2. **Atom.** A facet plus the role a repo holds it in, written as one short string: `lang:rust`, `about:subject:4127`, `with:subject:812`, or `alt:platform:node`. Everything Stargrep knows about a repo is a set of atoms, and every filter is made of atoms.
3. **Receipt.** What one source said about one repo, kept as it was. The summary model's answer is a receipt, with its claims and their quotes. Nothing edits a receipt.
4. **Decision.** One curation step in an append-only log, such as a merge, split, rename, or alias. Every decision can be undone.
5. **Projection.** A pure function from a repo's receipt, its GitHub facts, the vocabulary, and the decision log to the repo's atoms. It never calls a model, so it can run again whenever the rules change.
6. **Selection.** Atoms joined with AND, OR, and NOT. A search filter, a topic page, a digest subscription, and a saved search are each a selection.

Receipts and decisions are the only sources of truth. Atoms are rebuilt from them, so a curator can fix what a subject means without another model call.

## Roles say how a repo holds a value

`roles` in `packages/knowledge/src/registry.ts` has one entry per role. The entry gives the role's name in atom keys, the dimensions it accepts in the order a claim tries them, which filters reach it, its prompt line, whether it needs a quote, whether it may create a subject, and how many atoms of it one repo keeps.

| Role | In keys | Accepts | Reached by |
|---|---|---|---|
| `is` | `is` | kind | bare atoms |
| `status` | `status` | status | bare atoms |
| `written_in` | `written-in` | language | bare atoms |
| `runs_on` | `runs-on` | platform | bare atoms |
| `for` | `for` | language, platform, subject | bare atoms |
| `built_with` | `with` | language, platform, subject | its own atoms |
| `about` | `about` | subject | bare atoms |
| `trait` | `trait` | subject | bare atoms |
| `licensed` | `licensed` | license | bare atoms |
| `tagged` | `tagged` | subject | bare atoms |
| `alternative_to` | `alt` | language, platform, subject | its own atoms, as a comparison |
| `replaced_by` | `replaced-by` | language, platform, subject | its own atoms, as a comparison |

The summary model writes every role that has a prompt line. GitHub's license writes `licensed`, and a GitHub topic that names a known subject writes `tagged`.

The `matches` field decides which filters reach a role:

- `bare`: a bare atom such as `lang:rust` or `subject:4127` matches the role, and so do the values under it. Those are a subject's children and merged IDs, or a closed value's expansions, as TypeScript is under JavaScript. `lang:rust` matches both `written_in` and `for`.
- `qualified`: only the role's own atom matches it. `built_with` is the only such role, so a bare filter on the subject React finds repos for React or about React, not every app built with React. React's `with:` atom finds those.
- `comparison`: only the role's own atom matches it, and it never satisfies a bare filter. An alternative to Slack is not Slack.

## Atom keys have one form

An atom key is an optional role, a dimension prefix, and an id: `[role ":"] prefix ":" id`. The prefixes are `kind`, `lang`, `license`, `platform`, `status`, and `subject`. `AtomKey` decodes a key into an `Atom` and refuses an unknown id, a role that does not accept the dimension, or a subject ID that is not a positive integer written without leading zeros.

The encoder always writes the shortest form, so equal atoms get equal keys. When a dimension has only one role that bare atoms reach, that role is left out: `is:kind:app` is written `kind:app`.

A selection key joins atoms with two separators and one prefix. Spaces separate groups, which are joined with AND. `|` separates the atoms of a group, which are joined with OR. `-` negates a group. So `lang:rust subject:812|subject:9031 -kind:list` means Rust repos that hold either subject and are not lists. The empty string is everything. `normalize` sorts atoms and groups and drops repeats. It keeps subject IDs exactly as given, so a merge or its undo never rewrites a stored selection.

## Closed values follow one alias rule

Each closed value has an id, a label, aliases, `impliedBy` names, and expansions.

- **Aliases.** An alias is a spelling of its value, never a narrower or neighboring concept. `tui` is not an alias of the terminal platform, so TUI can be a subject. `node` and `nodejs` belong only to the Node.js platform. Every label key of an id, label, or alias belongs to exactly one closed value, which `registry.test.ts` checks.
- **Implied names.** An `impliedBy` name implies a value without spelling it, such as Chrome for the browser or SDK for library. It resolves only in a role that accepts nothing but that dimension. So `runs_on: Chrome` is the browser, while `alternative_to: Chrome` stays a comparison with the subject Chrome.
- **Expansions.** A filter on a value also matches the values it expands to. A JavaScript filter also matches TypeScript.

`reservedKeys` holds the label key of every id, label, and alias of a kind, language, platform, or status. No subject label may use one, so a claim such as `about: rust` cannot create a subject that competes with the language. License keys and `impliedBy` names reserve nothing. Licenses resolve only from GitHub's SPDX field, so PostgreSQL and zlib stay free to be subjects.

## Label keys give a term its identity

`labelKey(term)` applies NFKC, lowercases, turns runs of `-`, `_`, `/`, and whitespace into one space, and trims punctuation and symbols at the edges. It keeps a leading `.` and a trailing `+` or `#`, so C++, C#, .NET, and Node.js keep their identity. Every claim with the same key resolves the same way.

`labelKey` does not fold plurals or strip `js`. `agents` and `agent`, or `reactjs` and `react`, are joined by a curated alias, which a curator can see and undo. It returns `null` for a term with no letter or digit, and for a key longer than 80 characters. NFKC can lengthen a term, so the length check runs on the key.

`evidenceText` prepares text for quote matching. It strips link, emphasis, inline-code, HTML tag, heading, list, quote-block, and table syntax, then lowercases and collapses whitespace. The prompt input and the quote both go through it, so a model that quotes the rendered README still matches.

## The registry generates its copies

Two artifacts come from the registry, so the prompt, the database, and the decoder will name the same values:

- `packages/knowledge/src/registry.sql` holds the Postgres enums, the closed expansions, the reserved keys, and the functions that turn a stored atom into its key.
- `extractionLines()` renders the facets block of the summary prompt. The kinds are the only list the block carries.

To change a closed value or a role, edit `registry.ts` and run `bun run --cwd packages/knowledge generate`, then review the diff to `registry.sql`. The migration `20261107193409_knowledge` carries `registry.sql` whole, and a test checks that the migrated database holds exactly the enums and functions the registry generates. The `--> statement-breakpoint` lines in the file split it into the statements Drizzle's migrator runs one at a time. A later change ships only the delta: `alter type knowledge_<dim> add value '<id>'` for a new id, and `create or replace function` for each function whose body changed. Postgres cannot drop an enum value. A change to a prompt line changes what every new summary says, so it ships with a `summaryRecipe` bump in `packages/ai/src/models.ts`. Tests fail when a generated copy drifts from the registry.

Search reads nothing from the registry yet. `packages/core/src/search/vocabulary.ts` keeps a frozen list of twelve kinds and its own language table until search filters read atoms. The planner's schema uses those kinds, and the schema is part of `PlannerPrompt.version`, which keys the plan and answer caches.

`recipes` names the ways a page ranks a selection's members: `top` by stars, and `trending_7d` by stars gained over seven complete days.

## Where atoms are stored

`atomColumns` in `packages/db/src/schema.ts` gives each role one array column per dimension it accepts, and a test checks the map against `roles`. A closed dimension's column is on `repos`, and a subject column is in `repo_facets`.

- **Closed atoms** are typed arrays on the `repos` row, such as `kinds`, `written_in`, and `built_with_platforms`, thirteen in all. A broad closed filter then tests the row personal search already reads. No index sits on them yet.
- **Subject atoms** are subject IDs in `repo_facets`, one row per live repo, as the IDs claims first resolved to. A merge changes what an ID means, never the row. `members` joins the arrays a bare `subject:N` filter reaches. The schema generates it from the roles bare atoms match, so `built_with` stays out of it. `members` and `built_with` each have a GIN index.
- **Receipts** keep each answer as it was. A trigger refuses any edit except projection's markers.
- **Decisions** are the curation log, which only grows. `subjects`, `subject_labels`, `subject_canonical`, `subject_closure`, and `subject_matches` are the vocabulary and the maps the log derives. `subject_matches` stores what a filter on each subject matches. Search reads it by subject and every count reads it by origin, so the two agree by construction.
- **`extraction_batches`** will hold the bulk run's manifest, so a resumed run resends the request it already paid for.

`repos` also has `input_hash`, `summary_input_hash`, `receipt_id`, and `gone_at`, which marks a repo GitHub stopped serving publicly. A gone repo has no atoms and no `repo_facets` row. `saveFacts` sets `input_hash` from the facts it saves. `inputHash` in `input-hash.ts` hashes the README's object ID, the full name, the description, the topics, the language, and `inputVersion` as one JSON array with SHA-256. Bump `inputVersion` when the prompt starts reading those facts differently.

Triggers keep `repo_facets` current. A new repo gets a stale row. A change to a repo's receipt, language, license, topics, or `gone_at` marks it stale again. Four views read the stored atoms: `knowledge_labels` for label resolution, `knowledge_self_origins` for the rule that a repo is never its own alternative and never built with itself, `effective_atoms` for what a repo holds, and `matching_atoms` for every key whose filter matches it. `knowledge_refresh_counts()` recounts each subject's repos from `matching_atoms`, and a subject is listed once two repos hold it.

`packages/db/src/queries/knowledge.ts` is the only writer. One advisory lock per namespace guards the vocabulary. Minting a subject and recording a decision take it exclusively. Projection takes it shared and locks the `repos` rows it writes `for no key update`, in ID order. Every vocabulary change then calls `knowledge_invalidate`, which marks stale each repo whose projection could now differ. A projection either committed before the change, which then marks its row, or started after it and read it. So the order repos are projected in cannot change what they end up holding.

## Decoding an answer

`decodeFacets(raw, input)` in `claims.ts` reads the model's facets list item by item and never fails, so a bad fact never costs the summary. Each role with a prompt line is a lane.

- A list that is absent or not an array makes every lane `missing`.
- An item that is not an object, or names a role the model does not write, is dropped, and every lane turns `invalid`.
- An empty term, a term over 80 characters, or a term with no label key drops only that item and turns only its lane `invalid`. NFKC can lengthen a term past 80 characters, so `labelKey` returns null for it, and the decoder treats it like any unreadable fact.
- More facts than a role keeps all decode. Role limits belong to projection.
- At most 32 items are read.

Each claim records `found`, so projection never needs the prompt text again. It is `quote` when the quote's evidence text occurs in the description, topics, name, or cleaned README, `term` when only the term does, and `neither` otherwise. Markup alone has empty evidence text, which occurs in every input, so an empty needle never counts as found.

## Capturing an answer

The summary model writes `summary`, `keywords`, and `facets`, a flat list of `{ role, term, quote }`. The provider sees a schema in which every field of a fact is a free string, so a provider that constrains decoding always produces output that decodes, and one that only validates has nothing about a fact to reject. The port decodes the summary and keywords, turns lone surrogates into U+FFFD and drops U+0000, which Postgres refuses, and accepts any `facets` value. A summary that does not decode is an invalid answer and counts toward the repo's three-failure cap, as before facets. Then `decodeFacets` reads the facts against the exact text the prompt carried, so a fact never fails an answer and never counts as a failure.

`RepoKnowledge` in `packages/core/src/knowledge` saves answers in two commits. `capture` is commit A, `projectSaved` is commit B, and `accept` runs both for one group. Enrichment runs commit A for each answer as it arrives, so a chunk cut short keeps every answer it paid for, and commit B once for the chunk's saved repos. An answer the database refuses fails only its own repo, counted as that repo's failure. One commit A could not save for a reason any repo could hit is not counted and keeps its enrichment lease. The enrichment lease, how long it lasts for a provider batch, and how a failed call ends it are in `docs/architecture.md` under "Ingestion pipeline". On a branch of prod, 100 stand-in answers saved that way took 7.3 statements each, and one projection per answer took 24.7, most of it waiting on the knowledge lock behind each answer's mint.

- **Commit A** is `Db.knowledge.capture`. It takes the shared knowledge lock, locks the repos in ID order, and inserts each answer as a receipt. A second answer to the same source, input hash, and recipe keeps the first receipt, text and claims included. It saves the summary, keywords, and receipt of every repo whose README and input hash still equal the answer's and that is not gone, and it writes the legacy `repos.kind` column from the receipt's primary kind until search reads `kinds`. An answer with no facets list keeps the claims of the receipt the repo points at and names it in `carried_from`. An empty list is an answer, so it carries nothing, and a legacy receipt holds only the kind, so that is all such an answer keeps from one. It clears the enrichment lease the answer names, by the lease's end time, whether the summary was saved or not, and leaves any other attempt's lease in place. A repo whose inputs moved on, or that is gone, returns `Stale`, and its receipt stays as history.
- **Commit B** projects the saved repos, minting the subjects their claims need. It never calls a model. When it fails, the summary is already saved and searchable, and the projection sweep projects the repo from its receipt.

`primaryKind` in `projection.ts` is the kind projection puts first, before any correction: the first `is` claim whose key names a kind. Capture applies the same rule in SQL with `kindKeys`, and a test checks the two agree.

## Projection

`project` in `projection.ts` turns one repo's claims, its GitHub facts, the label index, and the curated rules into its atoms. It reads no clock, database, or model.

Claims come first, in the model's order, then the facts.

- The primary language is `written_in`, matched against language labels and aliases. The license is `licensed`, by exact SPDX id, so `NOASSERTION` gives no atom. A topic that spells a language is `for`, one that spells a platform is `runs_on`, and one whose key has a label is `tagged`. A topic never mints, never sets a kind or status, and never resolves an `impliedBy` name.
- A claim tries its role's closed dimensions first, so `for: Node.js` is `for:platform:node`. A role that accepts one closed dimension also resolves that dimension's `impliedBy` names, so `runs_on: Chrome` is the browser while `for: Chrome` is a subject.
- `status` and `replaced_by` need `found` to be `quote`.
- A claim in a role a bare atom does not reach, `built_with`, `alternative_to`, or `replaced_by`, is dropped when its key is the repo's name or `owner/name`. A project is never built with itself, an alternative to itself, or replaced by itself. The views apply the same rule at read time through `knowledge_self_origins`, for a subject a Link decision ties to the repo.
- A reserved key in a subject role is dropped. Any other subject claim resolves through the key's default label, and the split rules of that subject and of its canonical survivor may move it to a narrower child, up to three levels.
- A key with no label is recorded in `unresolved_keys`. In a role that may mint, it is also a mint request, and the repo's atoms are incomplete until the key is minted.
- Each role keeps at most its `max` distinct atoms, counting claims before facts. Every role's `max` fits its column's limit in the database.
- Corrections apply last. A present one goes first in its role, so the role's limit never drops it, and an absent one removes the atom.

Each claim and fact gets a verdict with its reason, which projection stores on the receipt.

`fold(log)` in `decisions.ts` turns the curation log into the state projection reads: merges, split rules, corrections, and the rest of what decisions set. An Undo removes its target from the fold, and undoing an Undo restores it. `apply(state, decision)` checks one more decision against the state and refuses what the state alone can prove wrong: a keep-apart pair joined by a merge, a cycle or a path deeper than three levels across Parent, Expand, and Split edges, a retired or merged-away subject, a repo that another subject is linked to, a merged origin included, a label another subject holds or no subject may hold, and a correction with no role. A merge between two subjects that a Parent, Expand, or Split path joins, such as a child into its own parent, is a cycle too, because it would fold the hierarchy into one meaning. Remove the edge first. An Undo that would make a later decision invalid is a conflict that names it. Checks that need the database belong to the curation service.

## Curation

`Curation` in `packages/core/src/knowledge/curation.ts` writes decisions. Every write goes through one path.

1. Read the log, fold it, and fail with `StaleRevision` when its head is not the caller's expected revision.
2. Check each decision of the batch against the fold before it with `extend`, or plan an undo with `undoing`. A refusal is `CurationRefused`, with the decision's index and reason. An undo that would leave a later decision invalid is `CurationConflict`, which names the later revisions. With `cascade`, the undo takes them out too, each as its own Undo, newest first.
3. Refuse a label key that projection already minted for another subject as `label-taken`, naming that subject. That case is a merge, which keeps both IDs. The check holds even when the same batch merges that subject in, so undoing the merge gives the key back.
4. Count the repos each decision moves. A decision that moves more than 1,000 needs the operator flag, or it fails with `OperatorRequired`.
5. Hand the rows and their change to `Db.knowledge.decide`, one transaction under the exclusive lock.

`changeBetween(before, after)` in `packages/knowledge/src/curation.ts` computes that change from two folds, so undo is the same code as any decision. `derive(state)` gives every row the log owns, each naming the decision that wrote it: subject presentation, decision labels, the merge map, and the closure, with every path of up to three edges, its weakest edge, and the decision that finished it. A Rename of a minted subject stores the label it replaces as `base`, and undoing the Rename puts it back. The change also names the subjects whose `subject_matches` rows to rebuild, and `knowledge_refresh_matches` rebuilds those and their ancestors' rows. The full rebuild is the same function over every subject, and a test checks the two agree after every random decision.

The invalidation follows from the two folds.

| Change | Marks stale |
|---|---|
| A key gains a decision label, from Create, Alias, Rename, a Split child, or an undo that puts one back | repos whose `unresolved_keys` hold the key, and the holders of a minted subject the label now outranks |
| A key loses its decision label, or moves to another subject | the holders of the subject that lost it |
| A merge or its undo, when a subject in either class has a split rule | the holders of both classes and of their split children |
| A split or its undo | the holders of the broad subject, of the IDs merged into it, and of the child |
| A correction or its undo | that repo |
| Status, Link, Parent, Expand, KeepApart | none |

A subject's holders are the repos whose stored arrays name it. The decision only marks rows stale, and the sweep re-projects them from their receipts.

Projection reads only the merges, splits, corrections, and undos (`Db.knowledge.rules`) and replays them with `rules` in `decisions.ts`, without checking them again. Curation checked each decision when it wrote it and keeps every active decision valid, so the replay gives the whole log's rules. Checking a subset would not: a Split can reuse a label that an Alias removal freed, and the subset holds the Split but not the removal. A property test compares the replay with the whole fold over 500 random logs and four pinned ones that a checked subset gets wrong, and after every decision of the database property test. A seed batch of two thousand Creates and Renames costs projection nothing.

Publish and Retire wait for pages. No selection exists yet, so both are refused as `not-live`, and the refusals that need selections or private namespaces arrive with them.

### Seeds and the usage floor

`planSeeds` in `packages/knowledge/src/seeds.ts` turns seed entries into decisions against the vocabulary as it is. A seed never merges.

- **Which subject.** An entry adopts the subject that holds its own key, such as the GitHub topic, else the one that holds its label's key. When neither key is held, a Create makes one. No repo count decides it, so the plan is the same whether or not the nightly count has run.
- **Which names.** A source's aliases often name a narrower or a neighboring concept, as `3d-printing` does for `3d`, so an alias counts only when it spells the entry's key or label another way: separators and dots, a plural s or es, a js suffix, a version number, or the words its initials abbreviate, as model context protocol does MCP. Reviewed synonyms count as they are. A name only counts when it spells a key that is free or already the adopted subject's, so one spelling family never ends up split between two subjects.
- **Other holders.** Every other subject that holds one of the entry's names keeps it. Its merge into the adopted subject goes to the queue for a judge, as channel `seed`.
- **What changes.** An accepting seed gives the adopted subject the seed's definition, and its label only when that writes the same name another way, such as its case, unless a decision already set them. The free names become aliases, and the subject takes the seed's status. An accepting seed never adopts a rejected subject and never overrides a status that is not candidate. A second run plans nothing.

- `seed:noise` rejects Hacktoberfest and its variants, open source, opensource, oss, and bare awesome. Their keys then resolve to a rejected subject and hide, instead of minting.
- `seed:github-explore` creates or adopts the 1,278 curated topics of [GitHub Explore](https://github.com/github/explore), with their short descriptions, as accepted. It skips a topic whose key is reserved and leaves the noise keys alone. `packages/core/seeds/github-explore.json` holds the topics under CC-BY-4.0 with their attribution, and `bun run --cwd packages/core github-explore <checkout> <commit>` regenerates it. `explore.ts` in `packages/core/src/knowledge` turns it into seed entries, with the short list of reviewed synonyms, such as postgres and k8s.

`Curation.floor` runs right after the nightly count. It accepts every canonical candidate on at least 3 repos, by that count, whose repos have at least 2 owners. Each acceptance is a Status decision with actor `rule:floor`, so it shows in the log and can be undone.

### The CLI

`bun run --cwd packages/core curate <command>` runs curation against `DATABASE_URL`.

- `preview <json>` prints what a Decision, or an array of them, would do, and writes nothing.
- `decide <json> --reason <why>` appends them in one transaction. `--operator` lets through a decision that moves more than 1,000 repos.
- `undo <revision> --reason <why>` takes a decision out of the fold. `--cascade` also takes out the later ones that lean on it.
- `log` prints the newest decisions, and `queue` prints merge proposals ranked by the repos they move, from spelling variants and from the seeds.
- `seed noise` and `seed github-explore` print a seed's plan and the repos it would move. `--apply` writes it, and `--json` prints every decision with its count.
- `floor` runs the nightly count and the usage floor now.

The queue proposes merges from two channels. One is spelling variants, keys that differ by a separator, a plural s, or a js suffix. Keys of three characters or fewer never pair, and a plural merges into its singular only when the singular has at least 5% of the plural's repos. The subject more repos hold survives, else the shorter key. The other channel is the seeds' other holders. Every count comes from `repo_facets`, not the nightly count. A judge decides each proposal. The embedding, ambiguity, and comparison-gap channels need data this repo does not keep yet.

## Legacy receipts

Summaries saved before receipts existed are kept as `legacy` receipts, so projection reads the kind that search reads today, with no model call. `bun run --cwd packages/core legacy-receipts` writes them. `DATABASE_URL` names the database.

- `legacyFacets` in `claims.ts` turns a summary's kind into the receipt's only claim, `is`, decoded like a model's list. The kind `other` gives no claim, so the repo projects to no kind. Only the `is` lane is answered, and every other lane is `missing`.
- Keywords stay text, in the receipt's `keywords` column as in `repos.keywords`, and mint no subjects. They mix categories, products, platforms, and dependencies, and they are lowercase, so as subjects they would fix the identity and the label of terms the summary model writes itself.
- The receipt's input hash joins two things. The first is the hash of the README object ID the summary describes and the repo's facts at the time of the run, the closest record of the prompt that is left. The second is the summary, keywords, and kind. One README can have been summarized more than once, so a different answer gets its own receipt. Its model is `legacy`, and its recipe is the summary's.
- The backfill walks live repos with a summary in ID order, 128 to a page, and each page is one transaction. It takes the shared knowledge lock, locks the page's `repos` rows `for no key update` in ID order, inserts the receipts, and points each repo at its receipt. The `receipt_id` trigger then marks the repo stale, and the sweep projects it. The shared lock keeps a mint's invalidation from marking `repo_facets` rows while the page's trigger marks them too.
- A repo whose legacy receipt already holds its summary, keywords, and recipe is skipped, so a rerun writes nothing. The summary model wrote the kind with them, so it never changes alone. A run that dies loses only its open page, and the next run starts again from the lowest ID. A repo summarized again since the last run gets a new receipt, or the earlier receipt of that same summary when its README went back to an earlier version. Older receipts stay as history. A repo with a model receipt is never touched.

## The sweep and the nightly count

`RepoKnowledge.reproject` in `packages/core/src/knowledge` projects stale `repo_facets` rows, lowest repo ID first, in groups of 64, at most 50 groups a run. A cron in `apps/worker/src/crons.ts` runs it every 10 minutes, from the same handler and on the same minutes as the enrichment sweep. Neon suspends a compute after 5 idle minutes, so a sweep at any other minute would keep the database from ever scaling to zero. Each group is one transaction under the shared lock. Its locked read names the receipt whose claims it read. A writer that moves `receipt_id` while the read waits on the row leaves Postgres re-reading the row but not the receipt, so that name differs from the row's, the guard skips the write, and the row stays stale for the next group. It folds the decision log's rules at the revision it holds the lock at, loads the labels its repos look up, and writes the closed arrays on `repos` only where they changed, so a projection that changes no closed atom leaves the hot row untouched. A repo that needs a new subject stays stale, its keys are minted under the exclusive lock, which marks stale every repo that looked them up, and it is projected again. A group that loses a deadlock is retried within the run, and the run goes on. Every multi-row writer of `repos` locks its rows in ID order, so the sweep and star sync never wait on each other in a cycle. The rows the sweep converges to are the same whatever order repos were first projected in, which a test checks against random orders.

`RepoKnowledge.count` runs `knowledge_refresh_counts()` every night at 03:30 UTC, a sweep minute. It sets each public subject's `repo_count` from `matching_atoms`, and `listed` follows from it. The usage floor runs in the same handler right after it, and a failed count skips the floor.

