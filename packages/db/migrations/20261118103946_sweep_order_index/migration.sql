-- The sweep sorted every repo that waited by a per-row count of its stargazers before it could send the first 100, which
-- outgrew the statement timeout once a bulk import filled the backlog. repos_sweep_order_idx holds the summary order
-- itself, so the sweep reads its first entries and stops. Its key needs the count on the row, so triggers on stars keep
-- synced_stargazers in the statement that changes a star: every change that starts or ends a current star moves the
-- count by one. They read the rows the statement wrote, so two statements that star one repo at once each add their
-- own, and a retry that changes nothing adds nothing. Each trigger locks its repos in ID order, as every multi-row
-- writer of repos does, but an upsert fires its UPDATE trigger before its INSERT trigger, so the app's star writes lock
-- every repo they can count first. TRUNCATE fires no delete trigger, so a truncate trigger sets every count to 0. The
-- count starts at 0 for every repo here, and `bun run --cwd packages/db count-stargazers` sets the stars that existed
-- before, in short batches, after the deploy.

-- Validating a function's body locks repos, so everything runs in this one statement. A deploy runs each migration in
-- one transaction, so no index can be built concurrently. A build blocks writes to repos, not reads, while it runs. The
-- new index is built before the old one is dropped, so the exclusive lock the drop takes on repos lasts only until the
-- commit. The triggers come last, so star writes wait only for that commit. The lock timeout fails the migration rather
-- than queue behind a long statement, and a rerun retries it.
do $sweep_order_index$
begin
set local lock_timeout = '1s';
-- Adds each delta to its repo's count.
create function stars_apply_stargazers(ids bigint[], deltas integer[])
returns void
language sql
as $apply$
  update repos r set synced_stargazers = r.synced_stargazers + d.delta
  from unnest(ids, deltas) as d (id, delta)
  where r.id = d.id and r.id in (select id from repos where id = any(ids) order by id for no key update)
$apply$;

-- One delta per repo the statement changed: a current star inserted adds one, one deleted takes one away, and an update
-- that unstars or stars again moves it by the difference.
create function stars_count_stargazers() returns trigger language plpgsql as $count$
begin
  if tg_op = 'INSERT' then
    perform stars_apply_stargazers(array_agg(repo_id), array_agg(delta))
    from (select repo_id, count(*)::integer as delta from new_rows where unstarred_at is null group by repo_id) d;
  elsif tg_op = 'DELETE' then
    perform stars_apply_stargazers(array_agg(repo_id), array_agg(delta))
    from (select repo_id, -count(*)::integer as delta from old_rows where unstarred_at is null group by repo_id) d;
  else
    perform stars_apply_stargazers(array_agg(repo_id), array_agg(delta))
    from (
      select repo_id, sum(delta)::integer as delta
      from (
        select repo_id, 1 as delta from new_rows where unstarred_at is null
        union all
        select repo_id, -1 from old_rows where unstarred_at is null
      ) changes
      group by repo_id
      having sum(delta) <> 0
    ) d;
  end if;
  return null;
end
$count$;

create function stars_reset_stargazers() returns trigger language plpgsql as $reset$
begin
  update repos set synced_stargazers = 0
  where id in (select id from repos where synced_stargazers <> 0 order by id for no key update);
  return null;
end
$reset$;
CREATE INDEX "repos_sweep_order_idx" ON "repos" ((("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null),"user_starred" DESC NULLS LAST,"synced_stargazers" DESC NULLS LAST,"stars" DESC NULLS LAST,"id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3 and (not (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null) or ("user_starred" or "stars" is null or "stars" >= 200 or ("stars" >= 50 and not (coalesce("description", '') <> '' or "topics" <> '[]'::jsonb))));
DROP INDEX "repos_sweep_idx";
create trigger stars_count_inserted after insert on stars referencing new table as new_rows
  for each statement execute function stars_count_stargazers();
create trigger stars_count_updated after update on stars referencing old table as old_rows new table as new_rows
  for each statement execute function stars_count_stargazers();
create trigger stars_count_deleted after delete on stars referencing old table as old_rows
  for each statement execute function stars_count_stargazers();
create trigger stars_count_truncated after truncate on stars
  for each statement execute function stars_reset_stargazers();
end
$sweep_order_index$;
