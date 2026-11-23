-- A library page read each repo's chip keys from matching_atoms, which resolves every subject a repo's filters reach
-- through subject_matches and the self rule and renders each key: about 50,000 buffers and 200 ms warm per 1,000 repos
-- on prod, and 3.4 s cold. repo_matching_keys holds each repo's unqualified matching_atoms keys, listed or not, in one
-- narrow row, so a page reads one row per repo and then each distinct subject once, for its listing and label. On a
-- branch of prod the same page read 10,700 buffers in 28 ms warm.
-- Triggers rewrite a repo's row in the statement that changes an input of its keys. Projection, mints, and decisions
-- write those inputs under the knowledge lock (packages/db/src/queries/knowledge/lock.ts), and a new repo holds nothing
-- until projection writes it, so no two writers recompute one repo at once. A migration that changes what
-- matching_atoms returns, such as a new role or closed expansion, refreshes every row. The table starts empty, and
-- `bun run --cwd packages/db backfill-matching-keys` fills it for the repos that existed before, in short batches,
-- after the deploy. Until then a page reads matching_atoms for a repo with no row.
CREATE TABLE "repo_matching_keys" (
	"repo_id" bigint PRIMARY KEY,
	"keys" text[] NOT NULL
);
--> statement-breakpoint
-- Creating a SQL function reads the tables its body names, and the foreign key and the triggers lock the tables they
-- name, so everything else runs in one statement, the last, and the lock timeout fails the migration rather than queue
-- reads behind it. A rerun retries it.
do $matching_keys$
begin
set local lock_timeout = '1s';
ALTER TABLE "repo_matching_keys" ADD CONSTRAINT "repo_matching_keys_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;

-- The rule each row holds: matching_atoms' unqualified keys, sorted, and an empty array for a repo with none. Only a
-- repo that exists gets a row.
create function knowledge_matching_keys(ids bigint[])
returns table (repo_id bigint, keys text[])
language sql stable
as $fn$
  select r.id, coalesce(k.keys, '{}')
  from repos r
  left join (
    select m.repo_id, array_agg(distinct m.atom order by m.atom) as keys
    from matching_atoms m
    where m.repo_id = any(ids) and not m.qualified
    group by m.repo_id
  ) as k on k.repo_id = r.id
  where r.id = any(ids)
  order by r.id
$fn$;

-- Rows are written in repo ID order, so two writers that refresh overlapping repos never wait on each other in a cycle.
-- Most calls refresh one repo from a row trigger. Planning matching_atoms takes a few milliseconds, more than reading
-- one repo's keys, and Postgres judged the generic plan too costly and planned every call: on a branch of prod, 500
-- single-repo refreshes took 2.9 to 3.5 s that way and 0.2 to 0.6 s with the generic plan kept for the session. The
-- same plan refreshed React's 28,000 holders as fast as a fresh one, about 3 s.
create function knowledge_refresh_matching_keys(ids bigint[])
returns void
language plpgsql
set plan_cache_mode = force_generic_plan
as $fn$
begin
  insert into repo_matching_keys (repo_id, keys)
  select k.repo_id, k.keys from knowledge_matching_keys(ids) as k
  on conflict (repo_id) do update set keys = excluded.keys
  where repo_matching_keys.keys is distinct from excluded.keys;
end
$fn$;

-- A decision rebuilt every subject_matches row of the subjects it touched and their ancestors, even when a status
-- change left those rows as they were. It now deletes only the rows the rule no longer gives and inserts only the
-- missing ones, so the triggers below see exactly the origins whose matches moved. The rows it leaves are the same.
create or replace function knowledge_refresh_matches(touched bigint[])
returns void
language sql
as $fn$
  with roots as (
    select t.id from unnest(touched) as t (id)
    union
    select c.ancestor_id from subject_closure c where c.descendant_id = any(touched)
  ),
  fresh as (
    select distinct root.id as subject_id, w.comparison, o.origin_id
    from roots r
    join subjects root on root.id = r.id
    cross join (values (false), (true)) as w (comparison)
    cross join lateral (
      select root.id as id
      union
      select cl.descendant_id from subject_closure cl
      where cl.ancestor_id = root.id and (not w.comparison or cl.via = 'split')
    ) as d
    join subjects ds on ds.id = d.id and ds.status <> 'rejected'
    cross join lateral (
      select d.id as origin_id
      union
      select sc.origin_id from subject_canonical sc where sc.canonical_id = d.id
    ) as o
    where root.status <> 'rejected'
      and not exists (select 1 from subject_canonical c where c.origin_id = root.id)
  ),
  removed as (
    delete from subject_matches m
    using roots r
    where m.subject_id = r.id
      and not exists (
        select 1 from fresh f
        where f.subject_id = m.subject_id and f.comparison = m.comparison and f.origin_id = m.origin_id)
  )
  insert into subject_matches (subject_id, comparison, origin_id)
  select f.subject_id, f.comparison, f.origin_id from fresh f
  where not exists (
    select 1 from subject_matches m
    where m.subject_id = f.subject_id and m.comparison = f.comparison and m.origin_id = f.origin_id);
$fn$;

-- An origin's matches moved, so every repo that stores the origin in any role refreshes. A merge, split, parent, or
-- rejection moves the matches of every origin it reaches. A merge or unmerge also moves the origins the self rule
-- reads, and each of those origins' matches move with it, so no trigger on subject_canonical is needed. Rows are only
-- inserted and deleted, never updated.
create function subject_matches_refresh_keys() returns trigger language plpgsql as $refresh$
begin
  perform knowledge_refresh_matching_keys(array(
    select f.repo_id
    from repo_facets f, (select array_agg(distinct c.origin_id) as ids from changed c) as o
    where f.members && o.ids or f.built_with && o.ids or f.alternative_to && o.ids or f.replaced_by && o.ids));
  return null;
end
$refresh$;

create trigger subject_matches_keys_inserted after insert on subject_matches
referencing new table as changed for each statement execute function subject_matches_refresh_keys();

create trigger subject_matches_keys_deleted after delete on subject_matches
referencing old table as changed for each statement execute function subject_matches_refresh_keys();

-- The self rule drops a with:, alt:, or replaced-by: key that names the repo's own project, so a link that moves
-- refreshes the repo it left and the repo it reached.
create function subjects_refresh_keys() returns trigger language plpgsql as $refresh$
begin
  perform knowledge_refresh_matching_keys(array_remove(array[old.repo_id, new.repo_id], null));
  return null;
end
$refresh$;

-- The facets row a repo's subject keys come from, inserted for every new live repo and rewritten by projection. It is
-- deleted only in the statement that sets the repo's gone_at, which the trigger on repos sees.
create function repo_facets_refresh_keys() returns trigger language plpgsql as $refresh$
begin
  perform knowledge_refresh_matching_keys(array[new.repo_id]);
  return null;
end
$refresh$;

create trigger repo_facets_keys_inserted after insert on repo_facets
for each row execute function repo_facets_refresh_keys();

create trigger repo_facets_keys_updated
  after update of for_subjects, built_with, about, traits, tagged, alternative_to, replaced_by on repo_facets
  for each row
  when ((old.for_subjects, old.built_with, old.about, old.traits, old.tagged, old.alternative_to, old.replaced_by)
    is distinct from (new.for_subjects, new.built_with, new.about, new.traits, new.tagged, new.alternative_to,
      new.replaced_by))
  execute function repo_facets_refresh_keys();

create function repos_refresh_keys() returns trigger language plpgsql as $refresh$
begin
  perform knowledge_refresh_matching_keys(array[new.id]);
  return null;
end
$refresh$;

-- Projection writes the closed arrays only where they change, and a star or facts write names none of them.
create trigger repos_keys_updated
  after update of kinds, statuses, written_in, runs_on, for_languages, for_platforms, built_with_languages,
    built_with_platforms, licensed, alt_languages, alt_platforms, replaced_by_languages, replaced_by_platforms, gone_at
  on repos for each row
  when ((old.kinds, old.statuses, old.written_in, old.runs_on, old.for_languages, old.for_platforms,
      old.built_with_languages, old.built_with_platforms, old.licensed, old.alt_languages, old.alt_platforms,
      old.replaced_by_languages, old.replaced_by_platforms, old.gone_at)
    is distinct from (new.kinds, new.statuses, new.written_in, new.runs_on, new.for_languages, new.for_platforms,
      new.built_with_languages, new.built_with_platforms, new.licensed, new.alt_languages, new.alt_platforms,
      new.replaced_by_languages, new.replaced_by_platforms, new.gone_at))
  execute function repos_refresh_keys();

create trigger subjects_keys_linked after update of repo_id on subjects
for each row when (old.repo_id is distinct from new.repo_id) execute function subjects_refresh_keys();
end
$matching_keys$;
