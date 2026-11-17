-- The summary policy's inputs: GitHub's star count as a star list or a facts read reports it, and whether a signed-in
-- user starred the repo. A column with a constant default, or none, is added in the catalog, so this rewrites no rows.
-- It still waits for an exclusive lock on repos, and every read of repos queues behind that wait, so the lock timeout
-- fails the migration rather than let one long statement on repos stall reads. The deploy then stops before the
-- Workers, and a rerun retries the add. The running Workers name the columns they insert and select, so they never see
-- them. The next migration builds the indexes that read them, so this one holds the lock only for the catalog change.
do $summary_policy_columns$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ADD COLUMN "stars" integer;
ALTER TABLE "repos" ADD COLUMN "user_starred" boolean DEFAULT false NOT NULL;
end
$summary_policy_columns$;
