-- Marks a repo whose summary the daily summary cap refused, so the library can count it as queued for later. A column
-- with a constant default is added in the catalog, so this rewrites no rows. It still waits for an exclusive lock on
-- repos, and every read of repos queues behind that wait, so the lock timeout fails the migration rather than let one
-- long statement on repos stall reads. The deploy then stops before the Workers, and a rerun retries the add. The
-- running Workers name the columns they insert and select, so they never see it.
do $summary_deferred$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ADD COLUMN "summary_deferred" boolean DEFAULT false NOT NULL;
end
$summary_deferred$;
