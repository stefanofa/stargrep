-- Pilot 2 missed its precision gate, so recipe 4 tightens the summary prompt's role lines and replaces recipe 3, and
-- projection now reads a for claim as about on a repo whose primary kind is list or learning. Every command here locks
-- a table the running Workers use, so they run as one statement, the last, which holds those locks only until the
-- commit. The lock timeout fails the migration rather than queue behind a long sweep, since a queued drop of the index
-- would block every read of repos, and a rerun retries it. The rebuilt index holds the repos due under recipe 4. Then
-- every repo projects again from the receipt it holds, under the new rule, with no model call.
do $recipe$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ALTER COLUMN "summary_recipe" SET DEFAULT 4;
DROP INDEX "repos_retryable_enrichment_idx";
CREATE INDEX "repos_retryable_enrichment_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 4 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3;
update repo_facets set stale = true where not stale;
end
$recipe$;
