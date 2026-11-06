ALTER TYPE "sync_request_outcome" ADD VALUE IF NOT EXISTS 'missing';--> statement-breakpoint
ALTER TYPE "sync_request_outcome" ADD VALUE IF NOT EXISTS 'claimed';--> statement-breakpoint
CREATE TABLE "rate_lines" (
	"key" text PRIMARY KEY,
	"busy_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_requests" ADD COLUMN IF NOT EXISTS "starts_at" timestamp with time zone;