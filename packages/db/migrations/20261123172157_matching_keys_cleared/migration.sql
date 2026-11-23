-- A decision recomputed the matching keys of every repo that holds an origin whose matches it moved, under the
-- exclusive knowledge lock. On a branch of prod, rejecting React recomputed 28,000 repos and held the lock for 2.7 s
-- warm and 71 s on a compute that had just woken, and a capture that waits on that lock fails at the 10 s limit. The
-- trigger on subject_matches now only sets those repos' keys to null: 0.24 s warm and 31 s just woken, which is mostly
-- reading the holders' pages. A library page reads matching_atoms for a repo with null keys, as for one the backfill
-- has not reached. The projection sweep fills them again, a batch at a time under the shared lock, so no decision
-- commits between the read of a batch's keys and its write. A row the trigger clears is inserted when missing, so a
-- backfill batch that read a repo's keys before the decision skips it instead of writing keys the decision made stale.
-- repo_matching_keys existed before this migration and every trigger above writes it, so everything runs in this one
-- statement and the lock timeout fails the migration rather than queue behind a long statement. A rerun retries it.
-- In prod the table is empty when this deploys, since the backfill runs after the deploy, so the index build takes no
-- time. On a branch of prod with all 1.5 million rows filled, the statement took 0.24 s, past no limit, but a cold
-- table could take longer, so this transaction allows a minute. The limit takes effect at the next statement, so it is
-- a statement of its own.
set local statement_timeout = '1min';
--> statement-breakpoint
do $matching_keys_cleared$
begin
set local lock_timeout = '1s';
ALTER TABLE "repo_matching_keys" ALTER COLUMN "keys" DROP NOT NULL;
CREATE INDEX "repo_matching_keys_cleared_idx" ON "repo_matching_keys" ("repo_id") WHERE "keys" is null;

-- Clears the keys of every repo that stores a moved origin in any role. Each role array has its own GIN index, so the
-- lookup reads only the holders.
create or replace function subject_matches_refresh_keys() returns trigger language plpgsql as $refresh$
begin
  insert into repo_matching_keys (repo_id, keys)
  select f.repo_id, null
  from repo_facets f, (select array_agg(distinct c.origin_id) as ids from changed c) as o
  where f.members && o.ids or f.built_with && o.ids or f.alternative_to && o.ids or f.replaced_by && o.ids
  order by f.repo_id
  on conflict (repo_id) do update set keys = null where repo_matching_keys.keys is not null;
  return null;
end
$refresh$;
end
$matching_keys_cleared$;
