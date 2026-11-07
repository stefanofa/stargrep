ALTER TABLE "repos" ADD COLUMN "summary_recipe" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "embedding_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP INDEX "repos_retryable_enrichment_idx";--> statement-breakpoint
CREATE INDEX "repos_retryable_enrichment_idx" ON "repos" ("enrich_retry_at","id") WHERE (("summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null) or "embedding_stale" or "summary_recipe" is distinct from 1) and "enrich_failures" < 3;