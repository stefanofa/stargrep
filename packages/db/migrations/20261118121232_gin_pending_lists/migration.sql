-- The projection sweep's 64-row write timed out in prod while a bulk import wrote repos. A write to a row of repos or
-- repo_facets that is not a HOT update adds the row's keys to the pending list of every GIN index on its table, and the
-- write that fills a list past gin_pending_list_limit, 4 MB by default, merges all of it into the index before it
-- returns. On a local copy of 2 million repos, writes shaped like the projection and the import stalled up to 12 s on
-- those merges. With 256 kB lists the worst stall was 4.4 s at the same throughput. Turning fastupdate off ended the
-- merges too but cut write throughput by a third. Setting the option rewrites no index and changes only the catalog,
-- but it takes an exclusive lock on each index, which blocks reads of its table until the commit. So all six run in
-- this one statement, and the lock timeout fails the migration rather than queue behind a long statement. A rerun
-- retries it.
do $gin_pending_lists$
begin
set local lock_timeout = '1s';
ALTER INDEX "repos_search_idx" SET (gin_pending_list_limit = 256);
ALTER INDEX "repo_facets_members_idx" SET (gin_pending_list_limit = 256);
ALTER INDEX "repo_facets_built_with_idx" SET (gin_pending_list_limit = 256);
ALTER INDEX "repo_facets_alternative_to_idx" SET (gin_pending_list_limit = 256);
ALTER INDEX "repo_facets_replaced_by_idx" SET (gin_pending_list_limit = 256);
ALTER INDEX "repo_facets_unresolved_keys_idx" SET (gin_pending_list_limit = 256);
end
$gin_pending_lists$;
