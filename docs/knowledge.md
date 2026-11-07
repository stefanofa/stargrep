# Repo knowledge

Stargrep keeps what it knows about a repo as a set of small typed facts. Search filters, topic pages, digests, and the API all read those facts the same way. This page explains the six ideas the model rests on and the registries in `packages/knowledge` that define its closed parts.

`packages/knowledge` is a leaf package that depends only on `effect`. It holds the registries, the atom and selection codecs, `labelKey`, `evidenceText`, and `extractionLines`. `packages/ai` and `packages/db` import it, and `packages/core` will. The tables that store atoms exist, with the query module that writes them. The extraction step and the projection that fill them are not built yet, so only the triggers in "Where atoms are stored" write to them.

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

`repos` also has `input_hash`, `summary_input_hash`, `receipt_id`, and `gone_at`, which marks a repo GitHub stopped serving publicly. A gone repo has no atoms and no `repo_facets` row.

Triggers keep `repo_facets` current. A new repo gets a stale row. A change to a repo's receipt, language, license, topics, or `gone_at` marks it stale again. Four views read the stored atoms: `knowledge_labels` for label resolution, `knowledge_self_origins` for the rule that a repo is never its own alternative, `effective_atoms` for what a repo holds, and `matching_atoms` for every key whose filter matches it. `knowledge_refresh_counts()` recounts each subject's repos from `matching_atoms`, and a subject is listed once two repos hold it.

`packages/db/src/queries/knowledge.ts` is the only writer, and nothing calls it yet. One advisory lock per namespace guards the vocabulary. Minting a subject and recording a decision take it exclusively. Projection takes it shared and locks the `repos` rows it writes `for no key update`, in ID order. Every vocabulary change then calls `knowledge_invalidate`, which marks stale each repo whose projection could now differ. A projection either committed before the change, which then marks its row, or started after it and read it. So the order repos are projected in cannot change what they end up holding.
