-- The sweep's partial index now holds only enrichment that needs no summary or whose summary the policy wants, so the
-- long tail outside the policy never enters it. The metadata sweep gets a partial index of its own on every repo due a
-- metadata embedding, the long tail included, which a repo leaves once its embedding lands. stars gets an index on each
-- repo's current stargazers, which the summary order counts. First, every repo a signed-in user stars now is marked,
-- locking its rows in ID order as every multi-row writer of repos does. A deploy runs each migration in one
-- transaction, so no index can be built concurrently. A build blocks writes to its table, not reads, while it runs.
-- All three are built before the old index is dropped, so the exclusive lock the drop takes on repos lasts only until
-- the commit. The lock timeout fails the migration rather than queue behind a long statement, and a rerun retries it.
do $summary_policy_indexes$
begin
set local lock_timeout = '1s';
UPDATE "repos" SET "user_starred" = true WHERE "id" IN (
  SELECT "id" FROM "repos" WHERE NOT "user_starred" AND "id" IN (
    SELECT s."repo_id" FROM "stars" s JOIN "github_accounts" a ON a."id" = s."account_id"
    WHERE a."claimed_by" IS NOT NULL AND s."unstarred_at" IS NULL
  ) ORDER BY "id" FOR NO KEY UPDATE
);
CREATE INDEX "stars_repo_idx" ON "stars" ("repo_id") WHERE "unstarred_at" is null;
CREATE INDEX "repos_sweep_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and "enrich_failures" < 3 and (not (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null) or ("user_starred" or "stars" is null or "stars" >= 200 or ("stars" >= 50 and not (coalesce("description", '') <> '' or "topics" <> '[]'::jsonb))));
CREATE INDEX "repos_metadata_sweep_idx" ON "repos" ("id") WHERE ("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "summary_recipe" is distinct from 5 or "summary_input_hash" is distinct from "input_hash") and "gone_at" is null and ("embedding" is null or ("embedding_source" = 'metadata' and "embedding_stale")) and (coalesce("description", '') <> '' or "topics" <> '[]'::jsonb);
DROP INDEX "repos_retryable_enrichment_idx";
end
$summary_policy_indexes$;
