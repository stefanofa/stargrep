# Repo knowledge

Stargrep keeps what it knows about a repo as a set of small typed facts. Search filters, topic pages, digests, and the API all read those facts the same way. This page explains the six ideas the model rests on and the registries in `packages/knowledge` that define its closed parts.

`packages/knowledge` is a leaf package that depends only on `effect`. It holds the registries, the atom and selection codecs, `labelKey`, `evidenceText`, `extractionLines`, the input hash, the facets decoder, the curation fold, and the projection. `packages/ai`, `packages/db`, and `packages/core` import it. A cron projects every repo from its GitHub facts today. The summary call does not extract facets yet, so no repo has a receipt, and nothing writes a decision.

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
- `extractionLines()` renders the facets block that the summary prompt will carry once the summary call extracts facets. Nothing reads it yet. The kinds are the only list the block carries.

To change a closed value or a role, edit `registry.ts` and run `bun run --cwd packages/knowledge generate`, then review the diff to `registry.sql`. The migration `20261107193409_knowledge` carries `registry.sql` whole, and a test checks that the migrated database holds exactly the enums and functions the registry generates. The `--> statement-breakpoint` lines in the file split it into the statements Drizzle's migrator runs one at a time. A later change ships only the delta: `alter type knowledge_<dim> add value '<id>'` for a new id, and `create or replace function` for each function whose body changed. Postgres cannot drop an enum value. Once the summary call extracts facets, a change to a prompt line changes what every new summary says, so from then on it ships with a `summaryRecipe` bump in `packages/ai/src/models.ts`. Tests fail when a generated copy drifts from the registry.

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

`carry(decoded, previous)` keeps the previous receipt's claims when every lane is `missing`, and names that receipt in `carried_from`. An empty list is an answer, so it carries nothing.

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

`fold(log)` in `decisions.ts` turns the curation log into the state projection reads: merges, split rules, corrections, and the rest of what decisions set. An Undo removes its target from the fold, and undoing an Undo restores it. `apply(state, decision)` checks one more decision against the state and refuses what the state alone can prove wrong: a keep-apart pair joined by a merge, a cycle or a path deeper than three levels across Parent, Expand, and Split edges, a retired or merged-away subject, a repo linked twice, a label another subject holds or no subject may hold, and a correction with no role. An Undo that would make a later decision invalid is a conflict that names it. Checks that need the database, such as slugs and listing, belong to the curation service.

## The sweep and the nightly count

`RepoKnowledge.reproject` in `packages/core/src/knowledge` projects stale `repo_facets` rows, lowest repo ID first, in groups of 64, at most 50 groups a run. A cron in `apps/worker/src/crons.ts` runs it every 10 minutes, from the same handler and on the same minutes as the enrichment sweep. Neon suspends a compute after 5 idle minutes, so a sweep at any other minute would keep the database from ever scaling to zero. Each group is one transaction under the shared lock. It folds the decision log at the revision it holds the lock at, loads the labels its repos look up, and writes the closed arrays on `repos` only where they changed, so a projection that changes no closed atom leaves the hot row untouched. A repo that needs a new subject stays stale, its keys are minted under the exclusive lock, which marks stale every repo that looked them up, and it is projected again. A group that loses a deadlock is retried within the run, and the run goes on. Every multi-row writer of `repos` locks its rows in ID order, so the sweep and star sync never wait on each other in a cycle. The rows the sweep converges to are the same whatever order repos were first projected in, which a test checks against random orders.

`RepoKnowledge.count` runs `knowledge_refresh_counts()` every night at 03:30 UTC, a sweep minute. It sets each public subject's `repo_count` from `matching_atoms`, and `listed` follows from it.

