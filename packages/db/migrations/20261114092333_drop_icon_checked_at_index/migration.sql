-- No query reads this index. The icon page filters icon_checked_at inside an OR with icon_key and walks repos in id
-- order, so it scans the primary key. Dropping an index waits for an exclusive lock on repos, and every read of repos
-- queues behind that wait, so the lock timeout fails the migration rather than let one long statement on repos stall
-- reads. The deploy then stops before the Workers, and a rerun retries the drop.
do $icon_index$
begin
set local lock_timeout = '1s';
DROP INDEX "repos_icon_checked_at_idx";
end
$icon_index$;
