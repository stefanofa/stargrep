-- A decision rebuilds only the subject_matches rows that can change: those of the subjects it touches and of their
-- ancestors. The full rebuild is the same rule over every subject, and a test checks after every generated decision
-- that the table equals it. Creating these functions reads subjects and the maps, so they run as one statement, the
-- last.
do $curation$
begin
create function knowledge_refresh_matches(touched bigint[])
returns void
language sql
as $$
  delete from subject_matches m
  using (
    select t.id from unnest(touched) as t (id)
    union
    select c.ancestor_id from subject_closure c where c.descendant_id = any(touched)
  ) as r
  where m.subject_id = r.id;
  with roots as (
    select t.id from unnest(touched) as t (id)
    union
    select c.ancestor_id from subject_closure c where c.descendant_id = any(touched)
  )
  insert into subject_matches (subject_id, comparison, origin_id)
  select distinct root.id, w.comparison, o.origin_id
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
    and not exists (select 1 from subject_canonical c where c.origin_id = root.id);
$$;

create or replace function knowledge_rebuild_matches()
returns void
language sql
as $$
  select knowledge_refresh_matches(array(select id from subjects));
$$;
end
$curation$;
