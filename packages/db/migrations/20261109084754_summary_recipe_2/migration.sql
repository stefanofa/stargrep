-- Recipe 2: the summary call also extracts facets. The rebuilt index holds the repos the enrichment sweep may send:
-- those due under recipe 2, a repo whose description, topics, or language changed since its summary among them, and
-- never a gone one. Every command here locks repos, and a deploy sends each statement in its own round trip inside one
-- transaction, so they run as one statement, the last, which holds that lock only until the commit.
do $recipe$
begin
ALTER TABLE "repos" ALTER COLUMN "summary_recipe" SET DEFAULT 2;
DROP INDEX "repos_retryable_enrichment_idx";
CREATE INDEX "repos_retryable_enrichment_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 2 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3;
end
$recipe$;
