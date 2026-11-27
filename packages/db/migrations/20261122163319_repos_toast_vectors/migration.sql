-- Reverses 20261103232729_repos_inline_rows. That migration set toast_tuple_target = 8160 on repos, so each row kept its
-- halfvec(1024) inline and a search over a library read no TOAST. A row with a vector then takes about 2.8 KB, two rows
-- a page, and the heap grew to 5.9 GB on prod, more than Neon's file cache holds. Every read of repos missed the cache
-- in turn, the library pages and progress counts that never read a vector among them. At the default target a row
-- moves its vector to TOAST and takes about 1 KB.
--
-- The reloption applies to rows written from now on. The rows already in the heap move only when the table is
-- rewritten, which pg_repack does online, so the extension is created here. PGlite and the local Postgres image do not
-- ship pg_repack, and nothing in the app needs it, so they go without.
--
-- Resetting a reloption takes a SHARE UPDATE EXCLUSIVE lock, which reads and writes do not wait on. The lock timeout
-- fails the migration rather than queue them behind a long-running statement. A rerun retries it.
do $repos_toast_vectors$
begin
set local lock_timeout = '1s';
if exists (select 1 from pg_available_extensions where name = 'pg_repack') then
  create extension if not exists pg_repack;
end if;
alter table repos reset (toast_tuple_target);
end
$repos_toast_vectors$;
