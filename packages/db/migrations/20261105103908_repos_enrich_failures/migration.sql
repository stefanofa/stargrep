ALTER TABLE "repos" ADD COLUMN "enrich_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "enrich_failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "repos_pending_enrichment_idx" ON "repos" ("enrich_failed_at","id") WHERE "summary" is null or "summary_readme_oid" is distinct from "readme_oid" or "embedding_model" is null;