-- Generated from packages/knowledge/src/registry.ts by `bun run --cwd packages/knowledge generate`. Edit the
-- registry, not this file, and carry the result into a migration.

create type knowledge_kind as enum (
  'app', 'library', 'framework', 'cli', 'plugin', 'template', 'list', 'learning', 'dataset', 'model', 'config',
  'database', 'system-software'
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
