-- Generated from packages/knowledge/src/registry.ts by `bun run --cwd packages/knowledge generate`. Edit the
-- registry, not this file, and carry the result into a migration.

create type knowledge_kind as enum (
  'app', 'library', 'framework', 'cli', 'plugin', 'template', 'list', 'learning', 'dataset', 'model', 'config'
);
--> statement-breakpoint

create type knowledge_language as enum (
  'abap', 'ada', 'apex', 'assembly', 'astro', 'blade', 'c', 'clojure', 'cobol', 'coffeescript', 'common-lisp', 'cpp',
  'crystal', 'csharp', 'css', 'd', 'dart', 'delphi', 'elixir', 'elm', 'emacs-lisp', 'erlang', 'fortran', 'fsharp',
  'gleam', 'go', 'groovy', 'haskell', 'hcl', 'html', 'java', 'javascript', 'jinja', 'julia', 'jupyter-notebook',
  'kotlin', 'lua', 'luau', 'makefile', 'markdown', 'matlab', 'mdx', 'nim', 'nix', 'nushell', 'objective-c',
  'objective-cpp', 'ocaml', 'pascal', 'perl', 'php', 'pkl', 'powershell', 'prolog', 'purescript', 'python', 'r',
  'racket', 'rescript', 'ruby', 'rust', 'scala', 'scheme', 'scss', 'shell', 'smalltalk', 'solidity', 'sql', 'stata',
  'svelte', 'swift', 'tcl', 'typescript', 'v', 'vala', 'verilog', 'vhdl', 'vim-script', 'visual-basic', 'vue', 'zig'
);
--> statement-breakpoint

create type knowledge_license as enum (
  'MIT', 'Apache-2.0', 'AGPL-3.0', 'GPL-3.0', 'GPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'BSD-3-Clause', 'BSD-2-Clause',
  '0BSD', 'MPL-2.0', 'ISC', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'Unlicense', 'OFL-1.1', 'EPL-2.0', 'OSL-3.0',
  'PostgreSQL', 'WTFPL', 'EUPL-1.1', 'EUPL-1.2', 'MS-PL', 'Zlib', 'BSL-1.0', 'MIT-0', 'Artistic-2.0'
);
--> statement-breakpoint

create type knowledge_platform as enum (
  'linux', 'macos', 'windows', 'ios', 'android', 'browser', 'terminal', 'node', 'deno', 'bun', 'wasm',
  'cloudflare-workers', 'jvm', 'dotnet', 'embedded'
);
--> statement-breakpoint

create type knowledge_status as enum ('deprecated', 'unmaintained');
--> statement-breakpoint

-- A filter on from_id also matches to_id, written out as a transitive closure.
create function knowledge_closed_expansions()
returns table (dim text, from_id text, to_id text)
language sql immutable parallel safe
as $$ values ('language'::text, 'javascript'::text, 'typescript'::text) $$;
--> statement-breakpoint

-- The label key of every id, label, and alias of a kind, language, platform, or status. No subject label may use one,
-- so "about: rust" cannot mint a subject that competes with the language. License keys and the names that only imply
-- a value reserve nothing, so PostgreSQL, zlib, Chrome, and Ubuntu stay free to be subjects.
create function knowledge_reserved_key(key text)
returns boolean
language sql immutable parallel safe
as $$
  select key = any (array[
    '.net', 'abandoned', 'abap', 'ada', 'android', 'apex', 'app', 'application', 'applications', 'apps', 'assembly',
    'astro', 'awesome list', 'bash', 'blade', 'boilerplate', 'browser', 'bun', 'c', 'c plus plus', 'c#', 'c++',
    'cli', 'clis', 'clojure', 'cloudflare workers', 'cobol', 'coffeescript', 'command line tool', 'common lisp',
    'config', 'configuration', 'course', 'cpp', 'crystal', 'csharp', 'css', 'd', 'dart', 'dataset', 'datasets',
    'delphi', 'deno', 'deprecated', 'dotfiles', 'dotnet', 'ecmascript', 'elisp', 'elixir', 'elm', 'emacs lisp',
    'embedded', 'embedded devices', 'erlang', 'examples', 'extension', 'extensions', 'f#', 'fortran', 'framework',
    'frameworks', 'fsharp', 'gleam', 'go', 'golang', 'groovy', 'haskell', 'hcl', 'html', 'ios', 'ipad', 'ipados',
    'iphone', 'java', 'javascript', 'jinja', 'js', 'julia', 'jupyter notebook', 'jvm', 'kotlin', 'learning',
    'learning resource', 'lib', 'libraries', 'library', 'libs', 'linux', 'list', 'lists', 'lua', 'luau', 'mac',
    'mac os', 'macos', 'makefile', 'markdown', 'matlab', 'mdx', 'model', 'model weights', 'models', 'nim', 'nix',
    'no longer maintained', 'node', 'node.js', 'nodejs', 'not maintained', 'nushell', 'objc', 'objective c',
    'objective c++', 'objective cpp', 'ocaml', 'osx', 'pascal', 'perl', 'php', 'pkl', 'plugin', 'plugins',
    'powershell', 'prolog', 'purescript', 'py', 'python', 'python3', 'r', 'racket', 'rescript', 'ruby', 'rust',
    'rust lang', 'scala', 'scheme', 'scss', 'shell', 'smalltalk', 'solidity', 'sql', 'starter', 'stata',
    'superseded', 'svelte', 'swift', 'tcl', 'template', 'templates', 'terminal', 'the browser', 'the terminal', 'ts',
    'tutorial', 'typescript', 'unmaintained', 'v', 'vala', 'vb', 'verilog', 'vhdl', 'vim script', 'viml',
    'vimscript', 'visual basic', 'visual basic .net', 'visual basic 6.0', 'vue', 'wasm', 'webassembly', 'windows',
    'workerd', 'zig', 'zsh'
  ])
$$;
--> statement-breakpoint

-- The key a consumer counts an atom by. A role that bare atoms match gives the bare key, "lang:rust" or
-- "subject:4127". Any other role keeps its name, as "with:subject:812" or "alt:platform:node".
create function knowledge_atom_key(role text, dim text, value text)
returns text
language sql immutable parallel safe
as $$
  select (case role
      when 'built_with' then 'with:'
      when 'alternative_to' then 'alt:'
      when 'replaced_by' then 'replaced-by:'
      else '' end)
    || (case dim when 'language' then 'lang' else dim end) || ':' || value
$$;
--> statement-breakpoint

-- The role-qualified key of an atom in a role that bare atoms match, as "for:subject:812" or "written-in:lang:rust".
-- Null when no other role of the dimension is matched by bare atoms, as for kinds, because the bare key already means
-- the same repos.
create function knowledge_role_key(role text, dim text, value text)
returns text
language sql immutable parallel safe
as $$
  select case
    when dim = 'language' and role in ('written_in', 'for') then
      (case role when 'written_in' then 'written-in' when 'for' then 'for' end)
      || ':lang:' || value
    when dim = 'platform' and role in ('runs_on', 'for') then
      (case role when 'runs_on' then 'runs-on' when 'for' then 'for' end)
      || ':platform:' || value
    when dim = 'subject' and role in ('for', 'about', 'trait', 'tagged') then
      (case role when 'for' then 'for' when 'about' then 'about' when 'trait' then 'trait' when 'tagged' then 'tagged' end)
      || ':subject:' || value
  end
$$;
--> statement-breakpoint

create function knowledge_no_nulls(anyarray)
returns boolean
language sql immutable parallel safe
as $$ select array_position($1, null) is null $$;
--> statement-breakpoint

CREATE TYPE "batch_state" AS ENUM('prepared', 'submitted', 'captured', 'abandoned');--> statement-breakpoint
CREATE TYPE "closure_via" AS ENUM('split', 'parent', 'expand');--> statement-breakpoint
CREATE TYPE "decision_kind" AS ENUM('create', 'merge', 'split', 'rename', 'alias', 'parent', 'expand', 'keep_apart', 'status', 'link', 'correct', 'publish', 'retire', 'undo');--> statement-breakpoint
CREATE TYPE "receipt_source" AS ENUM('model', 'stand-in', 'legacy');--> statement-breakpoint
CREATE TYPE "subject_status" AS ENUM('candidate', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "decisions" (
	"owner_id" text,
	"namespace" text GENERATED ALWAYS AS (case when owner_id is null then 'public' else 'user:' || owner_id end) STORED,
	"revision" bigint,
	"kind" "decision_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"undoes" bigint,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_pkey" PRIMARY KEY("namespace","revision"),
	CONSTRAINT "decisions_revision_positive" CHECK ("revision" > 0),
	CONSTRAINT "decisions_payload_tagged" CHECK (jsonb_typeof("payload") = 'object' and "payload" ->> '_tag' is not null),
	CONSTRAINT "decisions_actor_length" CHECK (length("actor") between 1 and 80),
	CONSTRAINT "decisions_reason_length" CHECK (length("reason") between 1 and 1000),
	CONSTRAINT "decisions_undo_names_revision" CHECK (("kind" = 'undo') = ("undoes" is not null)),
	CONSTRAINT "decisions_undoes_earlier" CHECK ("undoes" is null or "undoes" < "revision"),
	CONSTRAINT "decisions_private_unpublished" CHECK ("owner_id" is null or "kind" not in ('publish', 'retire'))
);
--> statement-breakpoint
CREATE TABLE "extraction_batches" (
	"id" uuid PRIMARY KEY,
	"adapter" text NOT NULL,
	"model" text NOT NULL,
	"recipe" integer NOT NULL,
	"request_key" text NOT NULL CONSTRAINT "extraction_batches_request_key_key" UNIQUE,
	"request_object" text NOT NULL,
	"provider_batch_id" text,
	"repo_ids" bigint[] NOT NULL,
	"input_hashes" text[] NOT NULL,
	"state" "batch_state" DEFAULT 'prepared'::"batch_state" NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_batches_adapter_known" CHECK ("adapter" in ('gateway-batch', 'claude-code')),
	CONSTRAINT "extraction_batches_recipe_positive" CHECK ("recipe" > 0),
	CONSTRAINT "extraction_batches_size" CHECK (cardinality("repo_ids") between 1 and 1000),
	CONSTRAINT "extraction_batches_items_paired" CHECK (cardinality("repo_ids") = cardinality("input_hashes")),
	CONSTRAINT "extraction_batches_no_nulls" CHECK (knowledge_no_nulls(repo_ids) and knowledge_no_nulls(input_hashes)),
	CONSTRAINT "extraction_batches_named_when_submitted" CHECK ("state" = 'prepared' or "adapter" = 'claude-code' or "provider_batch_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY,
	"repo_id" bigint NOT NULL,
	"source" "receipt_source" NOT NULL,
	"input_hash" text NOT NULL,
	"recipe" integer NOT NULL,
	"model" text NOT NULL,
	"batch_id" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"keywords" jsonb NOT NULL,
	"claims" jsonb NOT NULL,
	"lanes" jsonb NOT NULL,
	"dropped" jsonb DEFAULT '[]' NOT NULL,
	"carried_from" uuid,
	"raw_key" text,
	"projected_revision" bigint,
	"verdicts" jsonb,
	CONSTRAINT "receipts_answer_key" UNIQUE("repo_id","source","input_hash","recipe"),
	CONSTRAINT "receipts_id_repo_key" UNIQUE("id","repo_id"),
	CONSTRAINT "receipts_input_hash_sha256" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receipts_recipe_positive" CHECK ("recipe" > 0),
	CONSTRAINT "receipts_model_length" CHECK (length("model") between 1 and 120),
	CONSTRAINT "receipts_summary_present" CHECK (length("summary") > 0),
	CONSTRAINT "receipts_keywords_array" CHECK (jsonb_typeof("keywords") = 'array'),
	CONSTRAINT "receipts_claims_array" CHECK (jsonb_typeof("claims") = 'array'),
	CONSTRAINT "receipts_lanes_object" CHECK (jsonb_typeof("lanes") = 'object'),
	CONSTRAINT "receipts_dropped_array" CHECK (jsonb_typeof("dropped") = 'array'),
	CONSTRAINT "receipts_verdicts_array" CHECK ("verdicts" is null or jsonb_typeof("verdicts") = 'array')
);
--> statement-breakpoint
CREATE TABLE "repo_facets" (
	"repo_id" bigint PRIMARY KEY,
	"receipt_id" uuid,
	"revision" bigint DEFAULT 0 NOT NULL,
	"stale" boolean DEFAULT true NOT NULL,
	"projected_at" timestamp with time zone,
	"for_subjects" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"built_with" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"about" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"traits" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"tagged" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"alternative_to" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"replaced_by" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"members" bigint[] GENERATED ALWAYS AS (for_subjects || about || traits || tagged) STORED NOT NULL,
	"unresolved_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "repo_facets_subject_limits" CHECK (cardinality("for_subjects") <= 16 and cardinality("built_with") <= 8 and cardinality("about") <= 16 and cardinality("traits") <= 16 and cardinality("tagged") <= 20 and cardinality("alternative_to") <= 8 and cardinality("replaced_by") <= 4),
	CONSTRAINT "repo_facets_unresolved_limit" CHECK (cardinality("unresolved_keys") <= 64),
	CONSTRAINT "repo_facets_no_nulls" CHECK (knowledge_no_nulls(for_subjects) and knowledge_no_nulls(built_with) and knowledge_no_nulls(about) and knowledge_no_nulls(traits) and knowledge_no_nulls(tagged) and knowledge_no_nulls(alternative_to) and knowledge_no_nulls(replaced_by) and knowledge_no_nulls(unresolved_keys))
);
--> statement-breakpoint
CREATE TABLE "subject_canonical" (
	"namespace" text NOT NULL,
	"origin_id" bigint PRIMARY KEY,
	"canonical_id" bigint NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "subject_canonical_distinct" CHECK ("origin_id" <> "canonical_id")
);
--> statement-breakpoint
CREATE TABLE "subject_closure" (
	"namespace" text NOT NULL,
	"ancestor_id" bigint,
	"descendant_id" bigint,
	"depth" smallint NOT NULL,
	"via" "closure_via" NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "subject_closure_pkey" PRIMARY KEY("ancestor_id","descendant_id"),
	CONSTRAINT "subject_closure_depth" CHECK ("depth" between 1 and 3),
	CONSTRAINT "subject_closure_distinct" CHECK ("ancestor_id" <> "descendant_id")
);
--> statement-breakpoint
CREATE TABLE "subject_labels" (
	"namespace" text,
	"key" text,
	"subject_id" bigint,
	"is_default" boolean NOT NULL,
	"source" text NOT NULL,
	"revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_labels_pkey" PRIMARY KEY("namespace","key","subject_id"),
	CONSTRAINT "subject_labels_key_check" CHECK ("key" = btrim("key") and length("key") between 1 and 80 and not knowledge_reserved_key("key")),
	CONSTRAINT "subject_labels_source_known" CHECK ("source" in ('minted', 'decision')),
	CONSTRAINT "subject_labels_decision_revision" CHECK (("source" = 'decision') = ("revision" is not null))
);
--> statement-breakpoint
CREATE TABLE "subject_matches" (
	"subject_id" bigint,
	"comparison" boolean,
	"origin_id" bigint,
	CONSTRAINT "subject_matches_pkey" PRIMARY KEY("subject_id","comparison","origin_id")
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "subjects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" text,
	"namespace" text GENERATED ALWAYS AS (case when owner_id is null then 'public' else 'user:' || owner_id end) STORED NOT NULL,
	"label" text NOT NULL,
	"definition" text,
	"status" "subject_status" DEFAULT 'candidate'::"subject_status" NOT NULL,
	"repo_count" integer DEFAULT 0 NOT NULL,
	"listed" boolean GENERATED ALWAYS AS (repo_count >= 2) STORED NOT NULL,
	"repo_id" bigint,
	"origin_receipt_id" uuid,
	"origin_revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_id_namespace_key" UNIQUE("id","namespace"),
	CONSTRAINT "subjects_label_length" CHECK (length("label") between 1 and 120),
	CONSTRAINT "subjects_definition_length" CHECK (length("definition") <= 400),
	CONSTRAINT "subjects_repo_count_nonnegative" CHECK ("repo_count" >= 0),
	CONSTRAINT "subjects_private_unlinked" CHECK ("owner_id" is null or ("origin_receipt_id" is null and "repo_id" is null))
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "summary_input_hash" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "gone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "kinds" "knowledge_kind"[] DEFAULT '{}'::"knowledge_kind"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "statuses" "knowledge_status"[] DEFAULT '{}'::"knowledge_status"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "written_in" "knowledge_language"[] DEFAULT '{}'::"knowledge_language"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "runs_on" "knowledge_platform"[] DEFAULT '{}'::"knowledge_platform"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "for_languages" "knowledge_language"[] DEFAULT '{}'::"knowledge_language"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "for_platforms" "knowledge_platform"[] DEFAULT '{}'::"knowledge_platform"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "built_with_languages" "knowledge_language"[] DEFAULT '{}'::"knowledge_language"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "built_with_platforms" "knowledge_platform"[] DEFAULT '{}'::"knowledge_platform"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "licensed" "knowledge_license"[] DEFAULT '{}'::"knowledge_license"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "alt_languages" "knowledge_language"[] DEFAULT '{}'::"knowledge_language"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "alt_platforms" "knowledge_platform"[] DEFAULT '{}'::"knowledge_platform"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "replaced_by_languages" "knowledge_language"[] DEFAULT '{}'::"knowledge_language"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "replaced_by_platforms" "knowledge_platform"[] DEFAULT '{}'::"knowledge_platform"[] NOT NULL;--> statement-breakpoint
CREATE INDEX "decisions_kind_idx" ON "decisions" ("namespace","kind","revision");--> statement-breakpoint
CREATE INDEX "extraction_batches_open_idx" ON "extraction_batches" ("created_at") WHERE "state" in ('prepared', 'submitted');--> statement-breakpoint
CREATE INDEX "receipts_repo_idx" ON "receipts" ("repo_id","captured_at" DESC);--> statement-breakpoint
CREATE INDEX "receipts_batch_idx" ON "receipts" ("batch_id") WHERE "batch_id" is not null;--> statement-breakpoint
CREATE INDEX "repo_facets_members_idx" ON "repo_facets" USING gin ("members");--> statement-breakpoint
CREATE INDEX "repo_facets_built_with_idx" ON "repo_facets" USING gin ("built_with");--> statement-breakpoint
CREATE INDEX "repo_facets_alternative_to_idx" ON "repo_facets" USING gin ("alternative_to");--> statement-breakpoint
CREATE INDEX "repo_facets_replaced_by_idx" ON "repo_facets" USING gin ("replaced_by");--> statement-breakpoint
CREATE INDEX "repo_facets_unresolved_keys_idx" ON "repo_facets" USING gin ("unresolved_keys");--> statement-breakpoint
CREATE INDEX "repo_facets_stale_idx" ON "repo_facets" ("repo_id") WHERE "stale";--> statement-breakpoint
CREATE INDEX "subject_canonical_canonical_idx" ON "subject_canonical" ("canonical_id","origin_id");--> statement-breakpoint
CREATE INDEX "subject_closure_descendant_idx" ON "subject_closure" ("descendant_id","ancestor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_labels_decision_default_key" ON "subject_labels" ("namespace","key") WHERE "is_default" and "source" = 'decision';--> statement-breakpoint
CREATE UNIQUE INDEX "subject_labels_minted_default_key" ON "subject_labels" ("namespace","key") WHERE "is_default" and "source" = 'minted';--> statement-breakpoint
CREATE INDEX "subject_labels_subject_idx" ON "subject_labels" ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_labels_prefix_idx" ON "subject_labels" ("namespace","key" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "subject_matches_origin_idx" ON "subject_matches" ("origin_id","comparison","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_repo_key" ON "subjects" ("repo_id") WHERE "repo_id" is not null;--> statement-breakpoint
CREATE INDEX "subjects_status_idx" ON "subjects" ("status","id");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_undoes_fk" FOREIGN KEY ("namespace","undoes") REFERENCES "decisions"("namespace","revision");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_batch_id_extraction_batches_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "extraction_batches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_carried_from_receipts_id_fkey" FOREIGN KEY ("carried_from") REFERENCES "receipts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "repo_facets" ADD CONSTRAINT "repo_facets_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repo_facets" ADD CONSTRAINT "repo_facets_receipt_fk" FOREIGN KEY ("receipt_id","repo_id") REFERENCES "receipts"("id","repo_id");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_receipt_fk" FOREIGN KEY ("receipt_id","id") REFERENCES "receipts"("id","repo_id");--> statement-breakpoint
ALTER TABLE "subject_canonical" ADD CONSTRAINT "subject_canonical_origin_fk" FOREIGN KEY ("origin_id","namespace") REFERENCES "subjects"("id","namespace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_canonical" ADD CONSTRAINT "subject_canonical_canonical_fk" FOREIGN KEY ("canonical_id","namespace") REFERENCES "subjects"("id","namespace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_canonical" ADD CONSTRAINT "subject_canonical_revision_fk" FOREIGN KEY ("namespace","revision") REFERENCES "decisions"("namespace","revision") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_closure" ADD CONSTRAINT "subject_closure_ancestor_fk" FOREIGN KEY ("ancestor_id","namespace") REFERENCES "subjects"("id","namespace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_closure" ADD CONSTRAINT "subject_closure_descendant_fk" FOREIGN KEY ("descendant_id","namespace") REFERENCES "subjects"("id","namespace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_closure" ADD CONSTRAINT "subject_closure_revision_fk" FOREIGN KEY ("namespace","revision") REFERENCES "decisions"("namespace","revision") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_labels" ADD CONSTRAINT "subject_labels_subject_fk" FOREIGN KEY ("subject_id","namespace") REFERENCES "subjects"("id","namespace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_labels" ADD CONSTRAINT "subject_labels_revision_fk" FOREIGN KEY ("namespace","revision") REFERENCES "decisions"("namespace","revision") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_matches" ADD CONSTRAINT "subject_matches_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_matches" ADD CONSTRAINT "subject_matches_origin_id_subjects_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_origin_receipt_id_receipts_id_fkey" FOREIGN KEY ("origin_receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_origin_revision_fk" FOREIGN KEY ("namespace","origin_revision") REFERENCES "decisions"("namespace","revision") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_input_hash_sha256" CHECK ("input_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_summary_input_hash_sha256" CHECK ("summary_input_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_closed_atom_limits" CHECK (cardinality("kinds") <= 2 and cardinality("statuses") <= 2 and cardinality("written_in") <= 4 and cardinality("runs_on") <= 8 and cardinality("for_languages") <= 8 and cardinality("for_platforms") <= 8 and cardinality("built_with_languages") <= 4 and cardinality("built_with_platforms") <= 4 and cardinality("licensed") <= 1 and cardinality("alt_languages") <= 6 and cardinality("alt_platforms") <= 6 and cardinality("replaced_by_languages") <= 2 and cardinality("replaced_by_platforms") <= 2);--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_closed_atom_no_nulls" CHECK (knowledge_no_nulls(kinds) and knowledge_no_nulls(statuses) and knowledge_no_nulls(written_in) and knowledge_no_nulls(runs_on) and knowledge_no_nulls(for_languages) and knowledge_no_nulls(for_platforms) and knowledge_no_nulls(built_with_languages) and knowledge_no_nulls(built_with_platforms) and knowledge_no_nulls(licensed) and knowledge_no_nulls(alt_languages) and knowledge_no_nulls(alt_platforms) and knowledge_no_nulls(replaced_by_languages) and knowledge_no_nulls(replaced_by_platforms));--> statement-breakpoint

-- Below is what Drizzle cannot express: a deferrable key, the triggers, the views, the functions, and the backfill.
-- A mint inserts labels before the subjects they name, in one transaction.
alter table subject_labels alter constraint subject_labels_subject_fk deferrable initially deferred;
--> statement-breakpoint

-- A receipt is what one source said, kept as it was. Only projection's markers change, and batch_id and carried_from
-- may go to null when the row they name expires.
create function knowledge_receipt_immutable() returns trigger language plpgsql as $$
begin
  if (new.repo_id, new.source, new.input_hash, new.recipe, new.model, new.captured_at, new.summary, new.keywords,
      new.claims, new.lanes, new.dropped, new.raw_key)
     is distinct from
     (old.repo_id, old.source, old.input_hash, old.recipe, old.model, old.captured_at, old.summary, old.keywords,
      old.claims, old.lanes, old.dropped, old.raw_key)
     or (new.batch_id is distinct from old.batch_id and new.batch_id is not null)
     or (new.carried_from is distinct from old.carried_from and new.carried_from is not null) then
    raise exception 'receipt % is immutable except its projection markers', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger receipts_immutable before update on receipts
for each row execute function knowledge_receipt_immutable();
--> statement-breakpoint

create function knowledge_append_only() returns trigger language plpgsql as $$
begin
  -- The one deletion: a private log row whose owner the same statement deleted, reached by that cascade.
  if tg_op = 'DELETE' and old.owner_id is not null and not exists (select 1 from "user" u where u.id = old.owner_id) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end $$;
--> statement-breakpoint
create trigger decisions_append_only before update or delete on decisions
for each row execute function knowledge_append_only();
--> statement-breakpoint

create function knowledge_subject_identity() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_id is null and new.origin_receipt_id is null and new.origin_revision is null then
      raise exception 'a public subject needs a public receipt or a decision as its origin'
        using errcode = 'check_violation';
    end if;
  elsif new.id is distinct from old.id
     or new.owner_id is distinct from old.owner_id
     or new.origin_revision is distinct from old.origin_revision
     or (new.origin_receipt_id is not null and new.origin_receipt_id is distinct from old.origin_receipt_id) then
    -- The receipt may go to null when its repo is deleted. Nothing else about identity changes.
    raise exception 'subject % identity and namespace are immutable', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger subjects_identity before insert or update on subjects
for each row execute function knowledge_subject_identity();
--> statement-breakpoint

-- The labels resolution reads: every row except a minted default whose key also has a decision default. Projection,
-- stated query words, and lookups read this view, never subject_labels directly.
create view knowledge_labels as
select l.namespace, l.key, l.subject_id, l.is_default, l.source
from subject_labels l
where not (l.source = 'minted' and exists (
  select 1 from subject_labels d
  where d.namespace = l.namespace and d.key = l.key and d.source = 'decision' and d.is_default));
--> statement-breakpoint

-- The rule subject_matches stores, as a full rebuild. Membership rows widen through every closure edge, comparison
-- rows through splits only, and a rejected subject has no rows as a filter and is never reached as a descendant.
create function knowledge_rebuild_matches()
returns void
language sql
as $$
  delete from subject_matches;
  insert into subject_matches (subject_id, comparison, origin_id)
  select distinct root.id, w.comparison, o.origin_id
  from subjects root
  cross join (values (false), (true)) as w (comparison)
  cross join lateral (
    select root.id as id
    union
    select cl.descendant_id from subject_closure cl
    where cl.ancestor_id = root.id and (not w.comparison or cl.via = 'split')
  ) as d
  join subjects ds on ds.id = d.id and ds.status <> 'rejected'
  cross join lateral (
    select d.id as origin_id
    union
    select sc.origin_id from subject_canonical sc where sc.canonical_id = d.id
  ) as o
  where root.status <> 'rejected'
    and not exists (select 1 from subject_canonical c where c.origin_id = root.id);
$$;
--> statement-breakpoint

-- The canonical subject each query key names, when every key names exactly one accepted public meaning. Null
-- otherwise, so a clause with an unknown, ambiguous, or unaccepted word is never applied in part.
create function knowledge_meanings(keys text[])
returns bigint[]
language sql stable parallel safe
as $$
  with meaning as (
    select k.key, array_agg(distinct s.id) as ids
    from unnest(keys) as k (key)
    join knowledge_labels l on l.namespace = 'public' and l.key = k.key
    left join subject_canonical c on c.origin_id = l.subject_id
    join subjects s on s.id = coalesce(c.canonical_id, l.subject_id) and s.status = 'accepted'
    group by k.key
  )
  select case when count(*) = cardinality(keys) and bool_and(cardinality(ids) = 1)
              then array_agg(ids[1] order by key) end
  from meaning
$$;
--> statement-breakpoint

-- The origin IDs a filter on these subjects matches in repo_facets. Each subject resolves to its canonical ID first,
-- so a rejected subject expands to nothing. widen is true for membership and built_with, false for comparisons.
create function knowledge_origins(subjects bigint[], widen boolean)
returns bigint[]
language sql stable parallel safe
as $$
  select coalesce(array_agg(distinct m.origin_id order by m.origin_id), '{}')
  from unnest(subjects) as t (id)
  left join subject_canonical c on c.origin_id = t.id
  join subject_matches m on m.subject_id = coalesce(c.canonical_id, t.id) and m.comparison = not widen
$$;
--> statement-breakpoint

-- The one self-comparison rule: a comparison stored as origin_id on repo_id names the repo's own project when the
-- origin's canonical subject is linked to that repo.
create view knowledge_self_origins as
select o.origin_id, s.repo_id
from subjects s
cross join lateral (
  select s.id as origin_id
  union
  select sc.origin_id from subject_canonical sc where sc.canonical_id = s.id
) as o
where s.repo_id is not null
  and not exists (select 1 from subject_canonical c where c.origin_id = s.id);
--> statement-breakpoint

-- A repo_facets row exists for every live repo and turns stale whenever an input of its projection changes. A gone
-- repo has none, and nothing recreates it while it is gone. The update trigger does not fire on the closed arrays, so
-- projection never marks its own row stale.
create function knowledge_mark_stale() returns trigger language plpgsql as $$
begin
  if new.gone_at is null then
    insert into repo_facets (repo_id) values (new.id)
    on conflict (repo_id) do update set stale = true where not repo_facets.stale;
  end if;
  return null;
end $$;
--> statement-breakpoint
create trigger repos_knowledge_inserted after insert on repos
for each row execute function knowledge_mark_stale();
--> statement-breakpoint
create trigger repos_knowledge_inputs after update of receipt_id, language, license, topics, gone_at on repos
for each row
when (new.gone_at is null
      and (old.receipt_id is distinct from new.receipt_id
           or old.language is distinct from new.language
           or old.license is distinct from new.license
           or old.topics is distinct from new.topics
           or old.gone_at is not null))
execute function knowledge_mark_stale();
--> statement-breakpoint

-- Marks stale every repo whose projection could read differently after a vocabulary change, and returns how many.
-- Every mint and decision calls it under the namespace's exclusive lock, so it sees every committed projection.
-- new_keys gained a label. subjects are the IDs whose holders must re-project.
create function knowledge_invalidate(new_keys text[], subjects bigint[])
returns integer
language sql
as $$
  with marked as (
    update repo_facets f set stale = true
    where not f.stale
      and (f.unresolved_keys && new_keys or f.members && subjects or f.built_with && subjects
           or f.alternative_to && subjects or f.replaced_by && subjects)
    returning 1
  )
  select count(*)::integer from marked
$$;
--> statement-breakpoint

-- What a repo holds, for cards and the panel: closed atoms from its repos row, and subjects resolved to canonical IDs,
-- with rejected subjects dropped and a comparison dropped when it names the repo's own project. A gone repo holds
-- none. membership is false for comparisons, which never widen.
create view effective_atoms as
select r.id as repo_id, c.role, c.dim, c.value, c.membership
from repos r
cross join lateral (
  select 'is'::text as role, 'kind'::text as dim, v::text as value, true as membership from unnest(r.kinds) as v
  union all select 'status', 'status', v::text, true from unnest(r.statuses) as v
  union all select 'written_in', 'language', v::text, true from unnest(r.written_in) as v
  union all select 'runs_on', 'platform', v::text, true from unnest(r.runs_on) as v
  union all select 'for', 'language', v::text, true from unnest(r.for_languages) as v
  union all select 'for', 'platform', v::text, true from unnest(r.for_platforms) as v
  union all select 'built_with', 'language', v::text, true from unnest(r.built_with_languages) as v
  union all select 'built_with', 'platform', v::text, true from unnest(r.built_with_platforms) as v
  union all select 'licensed', 'license', v::text, true from unnest(r.licensed) as v
  union all select 'alternative_to', 'language', v::text, false from unnest(r.alt_languages) as v
  union all select 'alternative_to', 'platform', v::text, false from unnest(r.alt_platforms) as v
  union all select 'replaced_by', 'language', v::text, false from unnest(r.replaced_by_languages) as v
  union all select 'replaced_by', 'platform', v::text, false from unnest(r.replaced_by_platforms) as v
) as c
where r.gone_at is null
union all
select distinct f.repo_id, r.role, 'subject', m.subject_id::text, not r.comparison
from repo_facets f
cross join lateral (values
  ('for'::text, false, f.for_subjects),
  ('built_with', false, f.built_with),
  ('about', false, f.about),
  ('trait', false, f.traits),
  ('tagged', false, f.tagged),
  ('alternative_to', true, f.alternative_to),
  ('replaced_by', true, f.replaced_by)
) as r (role, comparison, origins)
cross join unnest(r.origins) as o (id)
left join subject_canonical c on c.origin_id = o.id
-- The origin's row under its own canonical subject. It is missing when that subject is rejected.
join subject_matches m on m.origin_id = o.id and m.comparison = r.comparison and m.subject_id = coalesce(c.canonical_id, o.id)
where not (r.comparison
           and exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id));
--> statement-breakpoint

-- Every atom key whose filter matches the repo, for counts, chips, profiles, snapshots, and statistics: the key
-- knowledge_atom_key gives, and the role-qualified key of a role bare atoms match. A TypeScript repo matches
-- lang:javascript, and a repo for pgvector matches subject:812 when PostgreSQL is its parent. built_with gives only
-- with: keys, widened the same way. A comparison widens through splits only. listed is false for a subject only one
-- repo holds.
create view matching_atoms as
select distinct m.repo_id, m.atom, m.membership, m.listed
from (
  select e.repo_id, k.atom, e.membership, true as listed
  from effective_atoms e
  cross join lateral (
    select e.value as value
    union all
    select x.from_id from knowledge_closed_expansions() x where e.membership and x.dim = e.dim and x.to_id = e.value
  ) as w
  cross join lateral (values
    (knowledge_atom_key(e.role, e.dim, w.value)),
    (knowledge_role_key(e.role, e.dim, w.value))
  ) as k (atom)
  where e.dim <> 'subject' and k.atom is not null
  union all
  select f.repo_id, k.atom, not r.comparison, s.listed
  from repo_facets f
  cross join lateral (values
    ('for'::text, false, f.for_subjects),
    ('built_with', false, f.built_with),
    ('about', false, f.about),
    ('trait', false, f.traits),
    ('tagged', false, f.tagged),
    ('alternative_to', true, f.alternative_to),
    ('replaced_by', true, f.replaced_by)
  ) as r (role, comparison, origins)
  cross join unnest(r.origins) as o (id)
  join subject_matches sm on sm.origin_id = o.id and sm.comparison = r.comparison
  join subjects s on s.id = sm.subject_id
  cross join lateral (values
    (knowledge_atom_key(r.role, 'subject', sm.subject_id::text)),
    (knowledge_role_key(r.role, 'subject', sm.subject_id::text))
  ) as k (atom)
  where k.atom is not null
    and not (r.comparison
             and exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id))
) as m;
--> statement-breakpoint

-- The nightly count behind listing: for every public subject, the distinct live repos whose bare, with:, or
-- comparison key matching_atoms emits, so it follows merges, splits, parents, rejection, the self rule, and the
-- tombstone. Returns how many subjects changed. Not a projection input, so it marks nothing stale.
create function knowledge_refresh_counts()
returns integer
language sql
as $$
  with counted as (
    select substring(m.atom from 'subject:([0-9]+)$')::bigint as subject_id, count(distinct m.repo_id)::integer as repos
    from matching_atoms m
    where m.atom ~ '^((with|alt|replaced-by):)?subject:[0-9]+$'
    group by 1
  ),
  fresh as (
    select s.id, coalesce(c.repos, 0) as repos
    from subjects s left join counted c on c.subject_id = s.id
    where s.owner_id is null
  ),
  changed as (
    update subjects s set repo_count = f.repos
    from fresh f
    where f.id = s.id and s.repo_count <> f.repos
    returning 1
  )
  select count(*)::integer from changed
$$;
--> statement-breakpoint

-- Every existing repo starts stale, so the projection sweep reaches it once it runs.
insert into repo_facets (repo_id) select id from repos where gone_at is null;
