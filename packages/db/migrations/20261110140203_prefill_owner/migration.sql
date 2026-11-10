-- The prefill driver's ownership row, so two drivers never resume, drop, or pay for the same manifests, and the link
-- from a fallback manifest to the manifest whose badly answered items it asks again. No Worker reads or writes either
-- table.
CREATE TABLE "prefill_owner" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"owner" uuid NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prefill_owner_one_row" CHECK (singleton)
);
--> statement-breakpoint
-- Adding the column waits for an exclusive lock on extraction_batches, which a running prefill holds row locks in, so
-- the lock timeout fails the migration rather than wait out a batch, and a rerun retries it. The column has no default,
-- so Postgres rewrites no rows.
do $prefill_owner$
begin
set local lock_timeout = '1s';
ALTER TABLE "extraction_batches" ADD COLUMN "retry_of" uuid;
ALTER TABLE "extraction_batches" ADD CONSTRAINT "extraction_batches_retry_of_extraction_batches_id_fkey" FOREIGN KEY ("retry_of") REFERENCES "extraction_batches"("id") ON DELETE SET NULL;
end
$prefill_owner$;
