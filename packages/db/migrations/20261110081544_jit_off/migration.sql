-- JIT compiles a statement once its estimated cost passes jit_above_cost. Search with a filter, the library's atom read,
-- and the facet lookup pass it on large inputs and spend seconds compiling what then runs in milliseconds. So every new
-- session on this database starts with JIT off, whichever role opens it. A session already open keeps its setting until
-- it reconnects. Setting a database parameter locks no table, and it runs inside the deploy's transaction.
do $jit$
begin
  execute format('alter database %I set jit = off', current_database());
end
$jit$;
