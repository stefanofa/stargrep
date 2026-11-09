-- The two resolution rules search reads, as set-returning functions with one SELECT each, so Postgres inlines them into
-- the search statement instead of planning a function body on every call. knowledge_meanings and knowledge_origins keep
-- their contracts and read the same rows through them, so each rule stays in one place. Validating a function body
-- reads the tables it names, so all four run as one statement, the last.
do $meanings$
begin
-- Each key that names exactly one accepted public subject, as its canonical ID. A key with no such subject, or with
-- two, has no row.
create function knowledge_key_meanings(keys text[])
returns table (key text, subject_id bigint)
language sql stable parallel safe
as $fn$
  select k.key, min(s.id)
  from unnest(keys) as k (key)
  join knowledge_labels l on l.namespace = 'public' and l.key = k.key
  left join subject_canonical c on c.origin_id = l.subject_id
  join subjects s on s.id = coalesce(c.canonical_id, l.subject_id) and s.status = 'accepted'
  group by k.key
  having count(distinct s.id) = 1
$fn$;

-- The origin IDs a filter on these subjects matches in repo_facets. Each subject resolves to its canonical ID first,
-- so a rejected subject expands to nothing. widen is true for membership and built_with, false for comparisons.
create function knowledge_origin_ids(subjects bigint[], widen boolean)
returns table (origin_id bigint)
language sql stable parallel safe
as $fn$
  select distinct m.origin_id
  from unnest(subjects) as t (id)
  left join subject_canonical c on c.origin_id = t.id
  join subject_matches m on m.subject_id = coalesce(c.canonical_id, t.id) and m.comparison = not widen
$fn$;

-- The canonical subject each query key names, when every key names exactly one accepted public meaning. Null
-- otherwise, so a clause with an unknown, ambiguous, or unaccepted word is never applied in part.
create or replace function knowledge_meanings(keys text[])
returns bigint[]
language sql stable parallel safe
as $fn$
  select case when count(*) = cardinality(keys) then array_agg(m.subject_id order by m.key) end
  from knowledge_key_meanings(keys) m
$fn$;

create or replace function knowledge_origins(subjects bigint[], widen boolean)
returns bigint[]
language sql stable parallel safe
as $fn$
  select coalesce(array_agg(o.origin_id order by o.origin_id), '{}') from knowledge_origin_ids(subjects, widen) o
$fn$;
end
$meanings$;
