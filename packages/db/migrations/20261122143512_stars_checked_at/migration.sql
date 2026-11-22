-- When the star probe last found an account's stored stars current, apart from stars_synced_at. A nullable column with
-- no default changes only the catalog, but it still takes a brief exclusive lock, so the lock timeout fails the
-- migration rather than queue reads behind it. A rerun retries it.
do $stars_checked_at$
begin
set local lock_timeout = '1s';
ALTER TABLE "github_accounts" ADD COLUMN "stars_checked_at" timestamp with time zone;
end
$stars_checked_at$;
