-- New impliedBy names give a kind to is claims that named none: shell script, installer, action, userscript, theme,
-- driver, and shader. They reserve nothing and change no SQL, but the sweep projects only stale repos, so every repo
-- projects again from the receipt it holds, under the new registry, with no model call. The update locks repo_facets,
-- which the running Workers use, so it is the only statement, and the lock timeout fails the migration rather than
-- queue behind a long sweep group. A rerun retries it.
do $implied$
begin
set local lock_timeout = '1s';
update repo_facets set stale = true where not stale;
end
$implied$;
