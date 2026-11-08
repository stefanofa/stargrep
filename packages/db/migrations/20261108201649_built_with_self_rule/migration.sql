-- The self rule now covers built_with. A project is never built with itself, just as it is never its own
-- alternative, so a with: atom whose subject is linked to the repo is dropped when it is read, as comparisons are.
-- Both views read repos, so they are replaced in one statement, the last, which holds that lock until the commit.
do $self_rule$
begin
-- What a repo holds, for cards and the panel: closed atoms from its repos row, and subjects resolved to canonical IDs,
-- with rejected subjects dropped, and a comparison or built_with atom dropped when it names the repo's own project. A
-- gone repo holds none. membership is false for comparisons, which never widen.
create or replace view effective_atoms as
select r.id as repo_id, c.role, c.dim, c.value, c.membership
from repos r
cross join lateral (
  select 'is'::text as role, 'kind'::text as dim, v::text as value, true as membership from unnest(r.kinds) as v
  union all select 'status', 'status', v::text, true from unnest(r.statuses) as v
  union all select 'written_in', 'language', v::text, true from unnest(r.written_in) as v
  union all select 'runs_on', 'platform', v::text, true from unnest(r.runs_on) as v
  union all select 'for', 'language', v::text, true from unnest(r.for_languages) as v
  union all select 'for', 'platform', v::text, true from unnest(r.for_platforms) as v
  union all select 'built_with', 'language', v::text, true from unnest(r.built_with_languages) as v
  union all select 'built_with', 'platform', v::text, true from unnest(r.built_with_platforms) as v
  union all select 'licensed', 'license', v::text, true from unnest(r.licensed) as v
  union all select 'alternative_to', 'language', v::text, false from unnest(r.alt_languages) as v
  union all select 'alternative_to', 'platform', v::text, false from unnest(r.alt_platforms) as v
  union all select 'replaced_by', 'language', v::text, false from unnest(r.replaced_by_languages) as v
  union all select 'replaced_by', 'platform', v::text, false from unnest(r.replaced_by_platforms) as v
) as c
where r.gone_at is null
union all
select distinct f.repo_id, r.role, 'subject', m.subject_id::text, not r.comparison
from repo_facets f
cross join lateral (values
  ('for'::text, false, false, f.for_subjects),
  ('built_with', false, true, f.built_with),
  ('about', false, false, f.about),
  ('trait', false, false, f.traits),
  ('tagged', false, false, f.tagged),
  ('alternative_to', true, true, f.alternative_to),
  ('replaced_by', true, true, f.replaced_by)
) as r (role, comparison, names_other, origins)
cross join unnest(r.origins) as o (id)
left join subject_canonical c on c.origin_id = o.id
-- The origin's row under its own canonical subject. It is missing when that subject is rejected.
join subject_matches m on m.origin_id = o.id and m.comparison = r.comparison and m.subject_id = coalesce(c.canonical_id, o.id)
where not (r.names_other
           and exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id));

-- Every atom key whose filter matches the repo, for counts, chips, profiles, snapshots, and statistics: the key
-- knowledge_atom_key gives, and the role-qualified key of a role bare atoms match. A TypeScript repo matches
-- lang:javascript, and a repo for pgvector matches subject:812 when PostgreSQL is its parent. built_with gives only
-- with: keys, widened the same way. A comparison widens through splits only. listed is false for a subject only one
-- repo holds.
create or replace view matching_atoms as
select distinct m.repo_id, m.atom, m.membership, m.listed
from (
  select e.repo_id, k.atom, e.membership, true as listed
  from effective_atoms e
  cross join lateral (
    select e.value as value
    union all
    select x.from_id from knowledge_closed_expansions() x where e.membership and x.dim = e.dim and x.to_id = e.value
  ) as w
  cross join lateral (values
    (knowledge_atom_key(e.role, e.dim, w.value)),
    (knowledge_role_key(e.role, e.dim, w.value))
  ) as k (atom)
  where e.dim <> 'subject' and k.atom is not null
  union all
  select f.repo_id, k.atom, not r.comparison, s.listed
  from repo_facets f
  cross join lateral (values
    ('for'::text, false, false, f.for_subjects),
    ('built_with', false, true, f.built_with),
    ('about', false, false, f.about),
    ('trait', false, false, f.traits),
    ('tagged', false, false, f.tagged),
    ('alternative_to', true, true, f.alternative_to),
    ('replaced_by', true, true, f.replaced_by)
  ) as r (role, comparison, names_other, origins)
  cross join unnest(r.origins) as o (id)
  join subject_matches sm on sm.origin_id = o.id and sm.comparison = r.comparison
  join subjects s on s.id = sm.subject_id
  cross join lateral (values
    (knowledge_atom_key(r.role, 'subject', sm.subject_id::text)),
    (knowledge_role_key(r.role, 'subject', sm.subject_id::text))
  ) as k (atom)
  where k.atom is not null
    and not (r.names_other
             and exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id))
) as m;
end
$self_rule$;
