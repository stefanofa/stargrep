-- The nightly counts read typed rows instead of atom keys. matching_atoms rendered every (repo, atom) pair as a string,
-- and each count parsed its IDs back out with a regex. At 100k repos the subject count spent over 11 s, the app's
-- statement timeout, building and sorting keys it then threw away. Two views now hold the rows matching_atoms renders:
-- matching_subjects keyed by subject_id, and matching_closed keyed by dimension and value. matching_atoms renders keys
-- from them, and marks role-qualified keys, so a reader filters on a column instead of a key's shape. Both functions
-- keep their names and results, so a Worker still running the old code counts the same.
--
-- Every command reads repos, repo_facets, or subjects, so they all run in this one statement, the last, and hold those
-- locks only until the commit. Replacing matching_atoms waits for an exclusive lock on the view, and every library read
-- queues behind that wait, so the lock timeout fails the migration rather than let a long count stall them. A rerun
-- retries it.
do $typed_match_views$
begin
set local lock_timeout = '1s';

-- Every subject a repo's filters match, one row per role and path. A repo that reaches a subject through two origins,
-- such as two children of one parent, has two rows, so count distinct repos. It follows merges, parents, and splits
-- through subject_matches, drops rejected subjects, and drops a comparison or built_with subject that names the repo's
-- own project. comparison is true for alternative_to and replaced_by, which widen through splits only.
create view matching_subjects as
select f.repo_id, r.role, r.comparison, sm.subject_id, s.listed
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
where not (r.names_other
           and exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id));

-- Every closed value a live repo's filters match: what it holds, widened by the registry's expansions, so a TypeScript
-- repo also matches javascript. A comparison never widens. A repo can reach one value twice, as a repo written in both
-- JavaScript and TypeScript does, so count distinct repos.
create view matching_closed as
select e.repo_id, e.role, e.dim, w.value, e.membership
from effective_atoms e
cross join lateral (
  select e.value as value
  union all
  select x.from_id from knowledge_closed_expansions() x where e.membership and x.dim = e.dim and x.to_id = e.value
) as w
where e.dim <> 'subject';

-- Every atom key whose filter matches the repo, for chips, profiles, snapshots, and statistics: the key
-- knowledge_atom_key gives, and the role-qualified key of a role bare atoms match, with qualified true. A TypeScript
-- repo matches lang:javascript, and a repo for pgvector matches subject:812 when PostgreSQL is its parent. built_with
-- gives only with: keys, widened the same way. A comparison widens through splits only. listed is false for a subject
-- only one repo holds. qualified comes last because a replaced view keeps its columns in order.
create or replace view matching_atoms as
select distinct m.repo_id, m.atom, m.membership, m.listed, m.qualified
from (
  select c.repo_id, k.atom, c.membership, true as listed, k.qualified
  from matching_closed c
  cross join lateral (values
    (knowledge_atom_key(c.role, c.dim, c.value), false),
    (knowledge_role_key(c.role, c.dim, c.value), true)
  ) as k (atom, qualified)
  where k.atom is not null
  union all
  select s.repo_id, k.atom, not s.comparison, s.listed, k.qualified
  from matching_subjects s
  cross join lateral (values
    (knowledge_atom_key(s.role, 'subject', s.subject_id::text), false),
    (knowledge_role_key(s.role, 'subject', s.subject_id::text), true)
  ) as k (atom, qualified)
  where k.atom is not null
) as m;

-- The nightly count behind listing: for every public subject, the distinct live repos whose filters match it in any
-- role, so it follows merges, splits, parents, rejection, the self rule, and the tombstone. Returns how many subjects
-- changed. Not a projection input, so it marks nothing stale.
create or replace function knowledge_refresh_counts()
returns integer
language sql
as $$
  with counted as (
    select m.subject_id, count(distinct m.repo_id)::integer as repos
    from matching_subjects m
    group by m.subject_id
  ),
  fresh as (
    select s.id, coalesce(c.repos, 0) as repos
    from subjects s left join counted c on c.subject_id = s.id
    where s.owner_id is null
  ),
  changed as (
    update subjects s set repo_count = f.repos
    from fresh f
    where f.id = s.id and s.repo_count <> f.repos
    returning 1
  )
  select count(*)::integer from changed
$$;

-- The nightly count of each closed value's bare key, so lookupFacets reads counts instead of scanning repos on every
-- call. Only the roles a bare key matches count, which are every closed role but built_with and the comparisons, whose
-- keys keep the role's name. lang:javascript counts TypeScript repos, as its filter does. A closed value no live repo
-- matches loses its row. Returns how many rows changed. It runs apart from knowledge_refresh_counts, so a slow subject
-- count never holds it back.
create or replace function knowledge_refresh_atom_stats()
returns integer
language sql
as $$
  with closed as (
    select knowledge_atom_key(c.role, c.dim, c.value) as atom, count(distinct c.repo_id)::integer as repos
    from matching_closed c
    where c.role not in ('built_with', 'alternative_to', 'replaced_by')
    group by 1
  ),
  kept as (
    insert into atom_stats (atom, repos)
    select atom, repos from closed
    on conflict (atom) do update set repos = excluded.repos
    where atom_stats.repos <> excluded.repos
    returning 1
  ),
  dropped as (
    delete from atom_stats a
    where not exists (select 1 from closed c where c.atom = a.atom)
    returning 1
  )
  select ((select count(*) from kept) + (select count(*) from dropped))::integer
$$;
end
$typed_match_views$;
