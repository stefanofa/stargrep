-- Icon checks live in repo_icon_checks since the migration 20261123081011_repo_icon_checks, and its backfill copied
-- every repo's check out of repos.icon_checked_at on prod, so nothing reads or writes the column. Dropping a column
-- rewrites no rows, but it takes an exclusive lock on repos, so the lock timeout fails the migration rather than queue
-- reads behind a long statement. A rerun retries it.
do $drop_icon_checked_at$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" DROP COLUMN "icon_checked_at";
end
$drop_icon_checked_at$;
