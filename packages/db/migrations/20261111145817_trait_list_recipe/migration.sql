-- Pilot 3 missed its precision gate, so recipe 5 tightens the summary prompt's role lines and replaces recipe 4, and
-- projection now keeps only listed traits with a found quote, drops a comparison whose quote speaks of a fork, and reads
-- interpreter, polyfill, and cms as kinds. Every command here locks a table the running Workers use, so they run as one
-- statement, the last, which holds those locks only until the commit. The lock timeout fails the migration rather than
-- queue behind a long sweep, since a queued drop of the index would block every read of repos, and a rerun retries it.
-- The rebuilt index holds the repos due under recipe 5. Then every repo projects again from the receipt it holds, under
-- the new rules, with no model call.
do $recipe$
begin
set local lock_timeout = '1s';
ALTER TABLE "repos" ALTER COLUMN "summary_recipe" SET DEFAULT 5;
DROP INDEX "repos_retryable_enrichment_idx";
CREATE INDEX "repos_retryable_enrichment_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3;
update repo_facets set stale = true where not stale;
end
$recipe$;
