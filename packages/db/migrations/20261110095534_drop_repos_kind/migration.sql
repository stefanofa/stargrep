-- The legacy kind column, which the running Workers neither read nor write. Postgres drops a column by marking it
-- dropped in the catalog, so this rewrites no rows. It still waits for an exclusive lock on repos, and every read of
-- repos queues behind that wait, so the lock timeout fails the migration rather than let one long statement on repos
-- stall reads. The deploy then stops before the Workers, and a rerun retries the drop. The command locks repos, so it
-- runs in the last statement, which holds that lock only until the commit.
do $kind$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" DROP COLUMN "kind";
end
$kind$;
