CREATE TABLE "atom_stats" (
	"atom" text PRIMARY KEY,
	"repos" integer NOT NULL,
	CONSTRAINT "atom_stats_repos_positive" CHECK ("repos" > 0)
);
--> statement-breakpoint
-- The nightly count of each closed value's bare key, so lookupFacets reads counts instead of scanning repos on every
-- call. It reads the closed half of matching_atoms: effective_atoms filtered to closed dimensions, which skips the
-- subject half of the view, widened by the registry's expansions, so lang:javascript counts TypeScript repos as its
-- filter does. A closed value no live repo matches loses its row. Returns how many rows changed. It runs apart from
-- knowledge_refresh_counts, so a slow subject count never holds it back. Validating the body reads the tables it
-- names, so this runs last.
create function knowledge_refresh_atom_stats()
returns integer
language sql
as $$
  with closed as (
    select k.atom, count(distinct e.repo_id)::integer as repos
    from effective_atoms e
    cross join lateral (
      select e.value as value
      union all
      select x.from_id from knowledge_closed_expansions() x where e.membership and x.dim = e.dim and x.to_id = e.value
    ) as w
    cross join lateral (select knowledge_atom_key(e.role, e.dim, w.value) as atom) as k
    where e.dim <> 'subject' and k.atom ~ '^(kind|lang|license|platform|status):'
    group by k.atom
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
