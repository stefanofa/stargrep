-- How many synced accounts star each repo now, which the summary order ranks by. A column with a constant default is
-- added in the catalog, so this rewrites no rows. It still waits for an exclusive lock on repos, and every read of
-- repos queues behind that wait, so the lock timeout fails the migration rather than let one long statement on repos
-- stall reads. The deploy then stops before the Workers, and a rerun retries the add. The running Workers name the
-- columns they insert and select, so they never see it. The next migration builds the index that reads it and the
-- trigger that keeps it, so this one holds the lock only for the catalog change.
do $synced_stargazers$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ADD COLUMN "synced_stargazers" integer DEFAULT 0 NOT NULL;
end
$synced_stargazers$;
