-- Two kinds join the registry, database and system-software, and the summary prompt lists them, so recipe 3 replaces
-- recipe 2. Adding an enum value locks no table. A transaction may add one but not use it before its commit, and nothing
-- here uses either value.
ALTER TYPE "knowledge_kind" ADD VALUE IF NOT EXISTS 'database';--> statement-breakpoint
ALTER TYPE "knowledge_kind" ADD VALUE IF NOT EXISTS 'system-software';--> statement-breakpoint

-- The new kinds' spellings join the reserved keys: database, databases, db, and system software. Replacing the function
-- locks no table.
create or replace function knowledge_reserved_key(key text)
returns boolean
language sql immutable parallel safe
as $$
  select key = any (array[
    '.net', 'abandoned', 'abap', 'ada', 'android', 'apex', 'app', 'application', 'applications', 'apps', 'assembly',
    'astro', 'awesome list', 'bash', 'blade', 'boilerplate', 'browser', 'bun', 'c', 'c plus plus', 'c#', 'c++',
    'cli', 'clis', 'clojure', 'cloudflare workers', 'cobol', 'coffeescript', 'command line tool', 'common lisp',
    'config', 'configuration', 'course', 'cpp', 'crystal', 'csharp', 'css', 'd', 'dart', 'database', 'databases',
    'dataset', 'datasets', 'db', 'delphi', 'deno', 'deprecated', 'dotfiles', 'dotnet', 'ecmascript', 'elisp',
    'elixir', 'elm', 'emacs lisp', 'embedded', 'embedded devices', 'erlang', 'examples', 'extension', 'extensions',
    'f#', 'fortran', 'framework', 'frameworks', 'fsharp', 'gleam', 'go', 'golang', 'groovy', 'haskell', 'hcl',
    'html', 'ios', 'ipad', 'ipados', 'iphone', 'java', 'javascript', 'jinja', 'js', 'julia', 'jupyter notebook',
    'jvm', 'kotlin', 'learning', 'learning resource', 'lib', 'libraries', 'library', 'libs', 'linux', 'list',
    'lists', 'lua', 'luau', 'mac', 'mac os', 'macos', 'makefile', 'markdown', 'matlab', 'mdx', 'model',
    'model weights', 'models', 'nim', 'nix', 'no longer maintained', 'node', 'node.js', 'nodejs', 'not maintained',
    'nushell', 'objc', 'objective c', 'objective c++', 'objective cpp', 'ocaml', 'osx', 'pascal', 'perl', 'php',
    'pkl', 'plugin', 'plugins', 'powershell', 'prolog', 'purescript', 'py', 'python', 'python3', 'r', 'racket',
    'rescript', 'ruby', 'rust', 'rust lang', 'scala', 'scheme', 'scss', 'shell', 'smalltalk', 'solidity', 'sql',
    'starter', 'stata', 'superseded', 'svelte', 'swift', 'system software', 'tcl', 'template', 'templates',
    'terminal', 'the browser', 'the terminal', 'ts', 'tutorial', 'typescript', 'unmaintained', 'v', 'vala', 'vb',
    'verilog', 'vhdl', 'vim script', 'viml', 'vimscript', 'visual basic', 'visual basic .net', 'visual basic 6.0',
    'vue', 'wasm', 'webassembly', 'windows', 'workerd', 'zig', 'zsh'
  ])
$$;
--> statement-breakpoint

-- Every command here locks a table the running Workers use, so they run as one statement, the last, which holds those
-- locks only until the commit. The lock timeout fails the migration rather than queue behind a long sweep, since a
-- queued drop of the index would block every read of repos, and a rerun retries it. The rebuilt index holds the repos due under recipe 3. A subject label on a key a new
-- kind owns would break the subject_labels check and could never resolve again, since projection drops a claim with a
-- reserved key, so it goes. Then every repo projects again from the receipt it holds, under the new registry, so a
-- recipe 2 answer whose kind the old list lacked gets it without a model call.
do $kinds$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ALTER COLUMN "summary_recipe" SET DEFAULT 3;
DROP INDEX "repos_retryable_enrichment_idx";
CREATE INDEX "repos_retryable_enrichment_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 3 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3;
delete from subject_labels where knowledge_reserved_key(key);
update repo_facets set stale = true where not stale;
end
$kinds$;
